import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { migrate } from "../server/db";
import { bootstrap } from "../server/auth";
import { hashToken } from "../server/crypto";
import { workflowImportRoutes } from "../server/workflow-imports";

// Exercise authenticated routes and real PostgreSQL locking independently of
// conversion/inference. The conversion contract has its own focused tests.
vi.mock("../server/workflow-import", async importOriginal => {
  const actual = await importOriginal<typeof import("../server/workflow-import")>();
  const manifest = JSON.parse(await readFile(new URL("../native-workflows/flux2-klein-t2i/manifest.json", import.meta.url), "utf8"));
  const graph = JSON.parse(await readFile(new URL("../native-workflows/flux2-klein-t2i/template.api.json", import.meta.url), "utf8"));
  return { ...actual, previewWorkflowImport: () => ({ manifest, graph, mapping: {} }) };
});

const connectionString = process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)("saved workflow revision transactions", () => {
  const schema = `cf_import_${randomUUID().replaceAll("-", "")}`;
  const app = Fastify(), worker = Fastify(), token = randomUUID();
  let root: Pool, pool: Pool, workspace: string;
  const headers = { cookie: `cf_session=${token}` };
  let previews = 0;
  let bothPreviewed: (() => void) | undefined;
  beforeAll(async () => {
    root = new Pool({ connectionString });
    await root.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    await migrate(pool);
    const user = await bootstrap(pool, "imports@example.test", "Fixture-password-long-27!", "Import fixture");
    workspace = user.workspaceId;
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(token), user.userId]);
    worker.get("/api/userdata", async () => ["fixture.json"]);
    worker.get("/api/userdata/:name", async () => ({}));
    worker.get("/object_info", async () => { previews++; if (previews === 2) bothPreviewed?.(); return {}; });
    const origin = await worker.listen({ host: "127.0.0.1", port: 0 });
    await pool.query("INSERT INTO workers(id,workspace_id,name,origin,enabled) VALUES($1,$2,'Fixture',$3,true)", [randomUUID(), workspace, origin]);
    await app.register(cookie);
    await workflowImportRoutes(app, pool);
    await app.ready();
  });
  afterAll(async () => {
    await app.close(); await worker.close(); await pool?.end();
    if (root) { await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end(); }
  });
  const path = () => `/api/v1/workspaces/${workspace}/workflow-imports`;
  const post = (url: string, payload: object = {}) => app.inject({ method: "POST", url, headers, payload });
  const create = async (label: string) => {
    const response = await post(path(), { name: "fixture.json", label });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { workflowId: string; revisionId: string };
  };

  it("reports a concurrent duplicate import as a conflict with no orphan revision", async () => {
    const responses = await Promise.all([post(path(), { name: "fixture.json", label: "Duplicate fixture" }), post(path(), { name: "fixture.json", label: "Duplicate fixture" })]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    expect((await pool.query("SELECT r.id FROM user_workflow_revisions r JOIN user_workflows w ON w.id=r.workflow_id WHERE w.slug='duplicate-fixture'")).rowCount).toBe(1);
  });

  it("normalizes a separator at the truncated slug boundary before persistence", async () => {
    const response = await post(path(), { name: "fixture.json", label: `${"a".repeat(63)} suffix` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().slug).toBe("a".repeat(63));
  });

  it("serializes competing reimports and preserves earlier revision content", async () => {
    const initial = await create("Reimport fixture");
    await post(`${path()}/${initial.workflowId}/publish`, { revisionId: initial.revisionId });
    const before = (await pool.query("SELECT manifest,template,source_sha256,graph_sha256 FROM user_workflow_revisions WHERE id=$1", [initial.revisionId])).rows[0];
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM user_workflows WHERE id=$1 FOR UPDATE", [initial.workflowId]);
    previews = 0;
    const barrier = new Promise<void>(resolve => { bothPreviewed = resolve; });
    // Starting inject requires consuming its thenable before waiting for the barrier.
    const first = Promise.resolve(post(`${path()}/${initial.workflowId}/reimport`));
    const second = Promise.resolve(post(`${path()}/${initial.workflowId}/reimport`));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([barrier, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Both previews did not reach the locked revision transaction")), 5000); })]);
    } finally { clearTimeout(timer); bothPreviewed = undefined; await blocker.query("ROLLBACK"); blocker.release(); }
    const responses = await Promise.all([first, second]);
    expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
    expect(responses.map(response => response.json().version).sort()).toEqual([2, 3]);
    const revisions = (await pool.query("SELECT version,published FROM user_workflow_revisions WHERE workflow_id=$1 ORDER BY version", [initial.workflowId])).rows;
    expect(revisions).toEqual([{ version: 1, published: true }, { version: 2, published: false }, { version: 3, published: false }]);
    const listing = await app.inject({ method: "GET", url: path(), headers });
    expect(listing.statusCode).toBe(200);
    expect(listing.json().find((item: { id: string }) => item.id === initial.workflowId)).toMatchObject({ version: 3, published: false, published_revision_id: initial.revisionId });
    expect((await pool.query("SELECT manifest,template,source_sha256,graph_sha256 FROM user_workflow_revisions WHERE id=$1", [initial.revisionId])).rows[0]).toEqual(before);
  });

  it("serializes competing publications and unpublish, without crossing workflows", async () => {
    const initial = await create("Publish fixture");
    const next = await post(`${path()}/${initial.workflowId}/reimport`);
    expect(next.statusCode, next.body).toBe(200);
    const results = await Promise.all([initial.revisionId, next.json().revisionId].map(revisionId => post(`${path()}/${initial.workflowId}/publish`, { revisionId })));
    expect(results.map(response => response.statusCode)).toEqual([200, 200]);
    expect((await pool.query("SELECT id FROM user_workflow_revisions WHERE workflow_id=$1 AND published", [initial.workflowId])).rowCount).toBe(1);
    const other = await create("Other fixture");
    expect((await post(`${path()}/${other.workflowId}/publish`, { revisionId: initial.revisionId })).statusCode).toBe(404);
    expect((await post(`${path()}/${randomUUID()}/unpublish`)).statusCode).toBe(404);
    const concurrent = await Promise.all([
      post(`${path()}/${initial.workflowId}/publish`, { revisionId: initial.revisionId }),
      post(`${path()}/${initial.workflowId}/unpublish`),
    ]);
    expect(concurrent.map(response => response.statusCode)).toEqual([200, 200]);
    expect((await post(`${path()}/${initial.workflowId}/unpublish`)).statusCode).toBe(200);
    expect((await pool.query("SELECT id FROM user_workflow_revisions WHERE workflow_id=$1 AND published", [initial.workflowId])).rowCount).toBe(0);
    expect((await app.inject({ method: "POST", url: `${path()}/${initial.workflowId}/publish`, payload: { revisionId: initial.revisionId } })).statusCode).toBe(401);
  });
});

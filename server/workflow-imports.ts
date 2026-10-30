import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import type { CapabilityBundle, CapabilityManifestV2 } from "../src/capabilities/types";
import { validateCapability } from "../src/capabilities/validate";
import type { ApiGraph } from "../src/workflow/build";
import type { ObjectInfo, UiWorkflow } from "../src/workflow/ui-to-api";
import { member, HttpError } from "./auth";
import { newId } from "./crypto";
import { transaction } from "./db";
import { previewWorkflowImport, WorkflowImportError } from "./workflow-import";
import { fetchHubWorkflow, hubReadiness, isHubUrl, parseWorkflow } from "./hub-source";
import { uiToApi } from "../src/workflow/ui-to-api";
import { assertLocalGraphPolicy } from "../src/capabilities/policy";
import { loadServerCatalogue } from "./catalogue";
import { checkFeatureEdit, featureFileName, newestFeatureFile, restoreFeatureIds } from "./feature-edit";

const base = "/api/v1/workspaces/:workspaceId/workflow-imports";
const workerQuery = z.object({ workerId: z.uuid().optional() });
// name: a workflow saved in ComfyUI, or an https ComfyHub/Comfy-Org address. json: a pasted or uploaded workflow file.
const sourceBody = z.object({ name: z.string().min(1).max(240).optional(), json: z.string().min(2).max(5_000_000).optional(), workerId: z.uuid().optional() }).strict()
  .refine((body) => !!body.name !== !!body.json, "Give either a saved workflow name, a Hub address or a workflow file");
const importBody = z.object({
  name: z.string().min(1).max(240).optional(),
  json: z.string().min(2).max(5_000_000).optional(),
  workerId: z.uuid().optional(),
  label: z.string().trim().min(1).max(120),
  slug: z.string().trim().max(64).optional(),
  published: z.boolean().optional(),
}).strict().refine((body) => !!body.name !== !!body.json, "Give either a saved workflow name, a Hub address or a workflow file");
const reimportBody = z.object({ name: z.string().min(1).max(240).optional(), workerId: z.uuid().optional() }).strict();
const revisionBody = z.object({ revisionId: z.uuid() }).strict();

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 64).replace(/^-+|-+$/g, "") || "workflow";

type Worker = { id: string; origin: string; api_prefix: string; workspace_id: string };

async function workerFor(pool: Pool, workspaceId: string, workerId?: string): Promise<Worker> {
  const worker = (await pool.query(
    "SELECT * FROM workers WHERE workspace_id=$1 AND enabled=true AND ($2::uuid IS NULL OR id=$2) ORDER BY (kind='cloud') ASC, checked_at DESC NULLS LAST, id LIMIT 1",
    [workspaceId, workerId ?? null],
  )).rows[0] as Worker | undefined;
  if (!worker) throw new HttpError(422, "No enabled ComfyUI worker is available");
  return worker;
}

async function comfyJson<T>(worker: Worker, path: string): Promise<T> {
  const response = await fetch(`${worker.origin}${path}`, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok) throw new HttpError(502, `ComfyUI answered ${response.status} for ${path}`);
  return await response.json() as T;
}

function sourceNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((name): name is string => typeof name === "string");
  if (value && typeof value === "object" && Array.isArray((value as { value?: unknown }).value)) {
    return (value as { value: unknown[] }).value.filter((name): name is string => typeof name === "string");
  }
  return [];
}

async function source(worker: Worker, name: string): Promise<{ ui: UiWorkflow; raw: string }> {
  if (name.startsWith("pasted-")) throw new HttpError(422, "A pasted workflow file cannot be fetched again. Import the new file instead");
  if (isHubUrl(name)) { const hub = await fetchHubWorkflow(name); return { ui: hub.ui, raw: hub.raw }; }
  const list = await comfyJson<unknown>(worker, "/api/userdata?dir=workflows");
  if (!sourceNames(list).includes(name)) throw new HttpError(404, "Saved ComfyUI workflow was not found");
  const response = await fetch(`${worker.origin}/api/userdata/${encodeURIComponent(`workflows/${name}`)}`, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok) throw new HttpError(502, `ComfyUI answered ${response.status} for the saved workflow`);
  const raw = await response.text();
  let ui: UiWorkflow;
  try { ui = JSON.parse(raw) as UiWorkflow; }
  catch { throw new HttpError(422, "Saved ComfyUI workflow is not valid JSON"); }
  return { ui, raw };
}

/** A pasted file has no address to fetch again; its hash stands in for the name. */
const pastedName = (raw: string) => `pasted-${sha256(raw).slice(0, 12)}.json`;

async function preview(worker: Worker, name: string, json?: string) {
  const input = json ? { ui: parseWorkflow(json), raw: json } : await source(worker, name);
  const objectInfo = await comfyJson<ObjectInfo>(worker, "/object_info");
  try {
    const result = previewWorkflowImport({ name, ui: input.ui, objectInfo });
    return { ...result, raw: input.raw };
  } catch (error) {
    if (error instanceof WorkflowImportError) throw new HttpError(422, error.message);
    throw error;
  }
}

function bindIdentity(manifest: CapabilityManifestV2, slug: string, version: number): CapabilityManifestV2 {
  const next = { ...manifest, id: `imported-${slug}`, version: `0.1.${version}` };
  return next;
}

export async function loadWorkspaceCatalogue(pool: Pool, baseCatalogue: CapabilityBundle[], workspaceId: string): Promise<CapabilityBundle[]> {
  const rows = (await pool.query(
    `SELECT r.manifest, r.template, r.mapping
     FROM user_workflow_revisions r
     JOIN user_workflows w ON w.id=r.workflow_id AND w.workspace_id=r.workspace_id
     WHERE r.workspace_id=$1 AND r.published=true`,
    [workspaceId],
  )).rows as Array<{ manifest: CapabilityManifestV2; template: ApiGraph; mapping?: { featureEdit?: boolean } }>;
  const imported: CapabilityBundle[] = [], edits = new Map<string, CapabilityBundle>();
  for (const row of rows) {
    const bundle = { manifest: row.manifest, template: row.template };
    try {
      validateCapability(bundle);
      if (row.mapping?.featureEdit) edits.set(bundle.manifest.id, bundle);
      else imported.push(bundle);
    } catch {
      // Invalid imported revisions stay invisible; never break the static catalogue.
    }
  }
  const ids = new Set(baseCatalogue.map((bundle) => bundle.manifest.id));
  // An edited graph keeps the feature's own manifest, so its screen and controls stay exactly as they were.
  const base = baseCatalogue.map((bundle) => edits.get(bundle.manifest.id) ?? bundle);
  return [...base, ...imported.filter((bundle) => !ids.has(bundle.manifest.id))];
}

export async function workflowImportRoutes(app: FastifyInstance, pool: Pool) {
  app.get(`${base}/sources`, async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    const { workerId } = workerQuery.parse(request.query);
    await member(pool, request, workspaceId, "creator");
    const worker = await workerFor(pool, workspaceId, workerId);
    const list = await comfyJson<unknown>(worker, "/api/userdata?dir=workflows");
    return { worker: { id: worker.id, origin: worker.origin }, names: sourceNames(list) };
  });

  app.post(`${base}/preview`, async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    const body = sourceBody.parse(request.body);
    await member(pool, request, workspaceId, "creator");
    const worker = await workerFor(pool, workspaceId, body.workerId);
    const result = await preview(worker, body.name ?? "", body.json);
    return { manifest: result.manifest, mapping: result.mapping };
  });

  // Always answers with what the worker still needs, also when the graph cannot be converted yet.
  app.post(`${base}/hub-check`, async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    const body = sourceBody.parse(request.body);
    await member(pool, request, workspaceId, "creator");
    const worker = await workerFor(pool, workspaceId, body.workerId);
    const input = body.json ? { ui: parseWorkflow(body.json), raw: body.json, url: undefined } : isHubUrl(body.name!) ? await fetchHubWorkflow(body.name!) : { ...(await source(worker, body.name!)), url: undefined };
    const objectInfo = await comfyJson<ObjectInfo>(worker, "/object_info");
    const readiness = hubReadiness(input.ui, objectInfo);
    const origin = { name: body.name ?? pastedName(input.raw), url: input.url, sha256: sha256(input.raw) };
    try {
      const result = previewWorkflowImport({ name: origin.name, ui: input.ui, objectInfo });
      return { source: origin, readiness, manifest: result.manifest, mapping: result.mapping, errors: [] };
    } catch (error) {
      if (error instanceof WorkflowImportError) return { source: origin, readiness, errors: error.errors };
      throw error;
    }
  });

  app.get(base, async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    await member(pool, request, workspaceId);
    const rows = (await pool.query(
      `SELECT w.id, w.slug, w.label, w.created_at, w.updated_at,
              r.id AS revision_id, r.version, r.published, r.source_name, r.created_at AS revision_created_at,
              (SELECT p.id FROM user_workflow_revisions p
               WHERE p.workspace_id=w.workspace_id AND p.workflow_id=w.id AND p.published=true) AS published_revision_id
       FROM user_workflows w
       JOIN LATERAL (
         SELECT id, version, published, source_name, created_at
         FROM user_workflow_revisions
         WHERE workflow_id=w.id AND workspace_id=w.workspace_id
         ORDER BY version DESC LIMIT 1
       ) r ON true
       WHERE w.workspace_id=$1 ORDER BY w.updated_at DESC, w.label`,
      [workspaceId],
    )).rows;
    return rows;
  });

  app.post(base, async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    const body = importBody.parse(request.body);
    const user = await member(pool, request, workspaceId, "creator");
    const worker = await workerFor(pool, workspaceId, body.workerId);
    const result = await preview(worker, body.name ?? "", body.json);
    const sourceName = body.name ?? pastedName(result.raw);
    const slug = body.slug ? slugify(body.slug) : slugify(body.label || sourceName.replace(/\.json$/i, ""));
    if (!slug) throw new HttpError(422, "Workflow slug is empty");
    const created = await transaction(pool, async client => {
      const existing = (await client.query("SELECT id, label FROM user_workflows WHERE workspace_id=$1 AND slug=$2", [workspaceId, slug])).rows[0];
      if (existing) throw new HttpError(409, `A workflow with slug ${slug} already exists; choose another label or slug`);
      const workflowId = newId(), revisionId = newId();
      const manifest = bindIdentity(result.manifest, slug, 1);
      const bundle = { manifest, template: result.graph };
      validateCapability(bundle);
      const inserted = await client.query("INSERT INTO user_workflows(id,workspace_id,slug,label,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,slug) DO NOTHING RETURNING id", [workflowId, workspaceId, slug, body.label, user.id]);
      if (!inserted.rowCount) throw new HttpError(409, `A workflow with slug ${slug} already exists; choose another label or slug`);
      await client.query(
        `INSERT INTO user_workflow_revisions(id,workspace_id,workflow_id,version,manifest,template,mapping,source_name,source_sha256,graph_sha256,published,created_by)
         VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [revisionId, workspaceId, workflowId, manifest, result.graph, result.mapping, sourceName, sha256(result.raw), sha256(JSON.stringify(result.graph)), body.published ?? false, user.id],
      );
      return { workflowId, revisionId, slug, version: 1, manifest };
    });
    return created;
  });

  app.post(`${base}/:workflowId/reimport`, async (request) => {
    const { workspaceId, workflowId } = z.object({ workspaceId: z.uuid(), workflowId: z.uuid() }).parse(request.params);
    const body = reimportBody.parse(request.body ?? {});
    const user = await member(pool, request, workspaceId, "creator");
    const workflow = (await pool.query("SELECT * FROM user_workflows WHERE workspace_id=$1 AND id=$2", [workspaceId, workflowId])).rows[0];
    if (!workflow) throw new HttpError(404, "Workflow not found");
    const latest = (await pool.query("SELECT * FROM user_workflow_revisions WHERE workspace_id=$1 AND workflow_id=$2 ORDER BY version DESC LIMIT 1", [workspaceId, workflowId])).rows[0];
    const worker = await workerFor(pool, workspaceId, body.workerId);
    const name = body.name ?? latest?.source_name;
    if (!name) throw new HttpError(422, "No source workflow name is available for reimport");
    const result = await preview(worker, name);
    const created = await transaction(pool, async client => {
      // Serialize every revision/publication mutation on the stable parent.
      // Fetch the version after the lock: previews may finish concurrently.
      const locked = (await client.query("SELECT slug FROM user_workflows WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [workspaceId, workflowId])).rows[0];
      if (!locked) throw new HttpError(404, "Workflow not found");
      const current = (await client.query("SELECT version FROM user_workflow_revisions WHERE workspace_id=$1 AND workflow_id=$2 ORDER BY version DESC LIMIT 1", [workspaceId, workflowId])).rows[0];
      const nextVersion = Number(current?.version ?? 0) + 1;
      const revisionId = newId();
      const manifest = bindIdentity(result.manifest, locked.slug, nextVersion);
      validateCapability({ manifest, template: result.graph });
      await client.query(
        `INSERT INTO user_workflow_revisions(id,workspace_id,workflow_id,version,manifest,template,mapping,source_name,source_sha256,graph_sha256,published,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11)`,
        [revisionId, workspaceId, workflowId, nextVersion, manifest, result.graph, result.mapping, name, sha256(result.raw), sha256(JSON.stringify(result.graph)), user.id],
      );
      await client.query("UPDATE user_workflows SET updated_at=now() WHERE id=$1 AND workspace_id=$2", [workflowId, workspaceId]);
      return { workflowId, revisionId, version: nextVersion, published: false };
    });
    return created;
  });

  /* Apply edits made to a feature in the node editor. The workflow must have been saved there under the feature's
     file name. The feature keeps its own manifest; the edited graph is stored as a draft until it is published. */
  app.post(`${base}/feature-edit`, async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    const body = z.object({ capabilityId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), workerId: z.uuid().optional() }).strict().parse(request.body);
    const user = await member(pool, request, workspaceId, "creator");
    const native = (await loadServerCatalogue()).find((bundle) => bundle.manifest.id === body.capabilityId);
    if (!native?.template) throw new HttpError(404, "This feature has no editable graph");
    const worker = await workerFor(pool, workspaceId, body.workerId);
    const listing = await comfyJson<unknown>(worker, "/api/userdata?dir=workflows&full_info=true");
    const files = Array.isArray(listing) ? listing.filter((item): item is { path: string; modified?: number } => !!item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string") : [];
    const name = newestFeatureFile(body.capabilityId, files);
    if (!name) throw new HttpError(404, `Save the workflow in the node editor as “${featureFileName(body.capabilityId)}” first (Ctrl+S).`);
    const input = await source(worker, name);
    const objectInfo = await comfyJson<ObjectInfo>(worker, "/object_info");
    let graph: ApiGraph;
    try { graph = restoreFeatureIds(uiToApi(input.ui, objectInfo) as ApiGraph, (input.ui as { extra?: { comfyfield?: { ids?: Record<string, string> } } }).extra?.comfyfield?.ids); }
    catch (error) { throw new HttpError(422, `The saved workflow could not be converted: ${(error as Error).message}`); }
    const check = checkFeatureEdit(native.manifest, native.template!, graph);
    if (check.errors.length) return { applied: false, errors: check.errors, changes: check.changes };
    try { assertLocalGraphPolicy(graph); validateCapability({ manifest: native.manifest, template: graph }); }
    catch (error) { return { applied: false, errors: [(error as Error).message], changes: check.changes }; }
    const slug = `feature-${body.capabilityId}`.slice(0, 64);
    const mapping = { featureEdit: true, capabilityId: body.capabilityId, changes: check.changes };
    const created = await transaction(pool, async (client) => {
      let workflow = (await client.query("SELECT id FROM user_workflows WHERE workspace_id=$1 AND slug=$2 FOR UPDATE", [workspaceId, slug])).rows[0];
      if (!workflow) {
        workflow = { id: newId() };
        await client.query("INSERT INTO user_workflows(id,workspace_id,slug,label,created_by) VALUES($1,$2,$3,$4,$5)", [workflow.id, workspaceId, slug, `Edited: ${native.manifest.title}`, user.id]);
      }
      const current = (await client.query("SELECT version FROM user_workflow_revisions WHERE workspace_id=$1 AND workflow_id=$2 ORDER BY version DESC LIMIT 1", [workspaceId, workflow.id])).rows[0];
      const version = Number(current?.version ?? 0) + 1, revisionId = newId();
      await client.query(
        `INSERT INTO user_workflow_revisions(id,workspace_id,workflow_id,version,manifest,template,mapping,source_name,source_sha256,graph_sha256,published,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11)`,
        [revisionId, workspaceId, workflow.id, version, native.manifest, graph, mapping, name, sha256(input.raw), sha256(JSON.stringify(graph)), user.id],
      );
      await client.query("UPDATE user_workflows SET updated_at=now() WHERE id=$1 AND workspace_id=$2", [workflow.id, workspaceId]);
      return { workflowId: workflow.id, revisionId, version };
    });
    return { applied: true, ...created, changes: check.changes };
  });

  app.post(`${base}/:workflowId/publish`, async (request) => {
    const { workspaceId, workflowId } = z.object({ workspaceId: z.uuid(), workflowId: z.uuid() }).parse(request.params);
    const body = revisionBody.parse(request.body);
    await member(pool, request, workspaceId, "creator");
    return transaction(pool, async client => {
      const workflow = (await client.query("SELECT id FROM user_workflows WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [workspaceId, workflowId])).rows[0];
      if (!workflow) throw new HttpError(404, "Workflow not found");
      const revision = (await client.query("SELECT id FROM user_workflow_revisions WHERE workspace_id=$1 AND workflow_id=$2 AND id=$3", [workspaceId, workflowId, body.revisionId])).rows[0];
      if (!revision) throw new HttpError(404, "Revision not found");
      await client.query("UPDATE user_workflow_revisions SET published=false WHERE workspace_id=$1 AND workflow_id=$2", [workspaceId, workflowId]);
      await client.query("UPDATE user_workflow_revisions SET published=true WHERE workspace_id=$1 AND workflow_id=$2 AND id=$3", [workspaceId, workflowId, body.revisionId]);
      await client.query("UPDATE user_workflows SET updated_at=now() WHERE id=$1 AND workspace_id=$2", [workflowId, workspaceId]);
      return { workflowId, revisionId: body.revisionId, published: true };
    });
  });

  app.post(`${base}/:workflowId/unpublish`, async (request) => {
    const { workspaceId, workflowId } = z.object({ workspaceId: z.uuid(), workflowId: z.uuid() }).parse(request.params);
    await member(pool, request, workspaceId, "creator");
    await transaction(pool, async client => {
      const workflow = (await client.query("SELECT id FROM user_workflows WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [workspaceId, workflowId])).rows[0];
      if (!workflow) throw new HttpError(404, "Workflow not found");
      await client.query("UPDATE user_workflow_revisions SET published=false WHERE workspace_id=$1 AND workflow_id=$2", [workspaceId, workflowId]);
      await client.query("UPDATE user_workflows SET updated_at=now() WHERE id=$1 AND workspace_id=$2", [workflowId, workspaceId]);
    });
    return { workflowId, published: false };
  });
}

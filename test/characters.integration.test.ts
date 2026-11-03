import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../server/app";
import { bootstrap } from "../server/auth";
import { hashPassword } from "../server/crypto";
import { migrate } from "../server/db";
import type { ServerConfig } from "../server/config";

const connectionString = process.env.TEST_DATABASE_URL;

describe.skipIf(!connectionString)("character records against real PostgreSQL", () => {
  const schema = `cf_char_${randomUUID().replaceAll("-", "")}`;
  const origin = "http://localhost:5173";
  const password = "Fixture-only-password-527!";
  let root: Pool;
  let pool: Pool;
  let server: Awaited<ReturnType<typeof buildServer>>;
  let config: ServerConfig;
  let workspaceId: string;
  let ownerId: string;
  let adminCookie: string;
  let viewerCookie: string;
  let foreignWorkspaceId: string;
  let foreignCookie: string;
  let projectId: string;
  let otherProjectId: string;
  let projectImageId: string;
  let sharedReferenceId: string;
  let otherProjectImageId: string;
  let projectVideoId: string;
  let storageRoot: string;

  function url(path: string, project = projectId, workspace = workspaceId) {
    return `/api/v1/workspaces/${workspace}/projects/${project}/${path}`;
  }

  function request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    payload?: unknown,
    cookie = adminCookie,
  ) {
    return server.app.inject({
      method,
      url: path,
      headers: { origin, cookie },
      payload: payload as Record<string, unknown>,
    });
  }

  async function login(email: string) {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin },
      payload: { email, password },
    });
    expect(response.statusCode).toBe(200);
    return String(response.headers["set-cookie"]).split(";")[0];
  }

  async function addAsset(project: string | null, mediaType: "image" | "reference" | "video", name: string) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO assets(
         id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,11,$9,$10)`,
      [id, workspaceId, project, name, mediaType, mediaType === "video" ? "video/mp4" : "image/png",
        `${workspaceId}/${id}`, `${mediaType}-${id}`.padEnd(64, "0").slice(0, 64), ownerId,
        JSON.stringify({ width: 1024, height: 1024, source: name })],
    );
    return id;
  }

  beforeAll(async () => {
    root = new Pool({ connectionString });
    await root.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    await migrate(pool);
    await migrate(pool);
    const scratchRoot = process.env.COMFYFIELD_TEST_TEMP_ROOT ?? tmpdir();
    await mkdir(scratchRoot, { recursive: true });
    storageRoot = await mkdtemp(join(scratchRoot, "comfyfield-characters-"));
    config = {
      databaseUrl: connectionString!,
      storageRoot,
      masterKey: randomBytes(32),
      publicOrigin: origin,
      host: "127.0.0.1",
      port: 8787,
      sessionTtlHours: 1,
      inviteTtlHours: 1,
      maxUploadBytes: 1024 * 1024,
      cookieSecure: false,
    };
    const owner = await bootstrap(pool, "admin@example.test", password, "Character Studio");
    ownerId = owner.userId;
    workspaceId = owner.workspaceId;

    const viewerId = randomUUID();
    const foreignUserId = randomUUID();
    foreignWorkspaceId = randomUUID();
    await pool.query(
      "INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3),($4,$5,$6)",
      [viewerId, "viewer@example.test", await hashPassword(password),
        foreignUserId, "foreign@example.test", await hashPassword(password)],
    );
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')", [workspaceId, viewerId]);
    await pool.query("INSERT INTO workspaces(id,name) VALUES($1,'Foreign Studio')", [foreignWorkspaceId]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')", [foreignWorkspaceId, foreignUserId]);

    server = await buildServer(config, pool);
    await server.app.ready();
    adminCookie = await login("admin@example.test");
    viewerCookie = await login("viewer@example.test");
    foreignCookie = await login("foreign@example.test");

    const project = await request("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Portraits" });
    projectId = project.json().id;
    const otherProject = await request("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Other" });
    otherProjectId = otherProject.json().id;
    projectImageId = await addAsset(projectId, "image", "project.png");
    sharedReferenceId = await addAsset(null, "reference", "shared.png");
    otherProjectImageId = await addAsset(otherProjectId, "image", "other.png");
    projectVideoId = await addAsset(projectId, "video", "clip.mp4");
  }, 30000);

  afterAll(async () => {
    await server?.app.close();
    await pool?.end();
    if (root) {
      await root.query(`DROP SCHEMA ${schema} CASCADE`);
      await root.end();
    }
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  it("enforces strict creator-only creation and project-scoped image references", async () => {
    const valid = {
      idempotencyKey: "strict-fixture",
      name: "Ada",
      referenceAssetIds: [projectImageId],
    };
    expect((await request("POST", url("characters"), valid, viewerCookie)).statusCode).toBe(403);
    expect((await request("POST", url("characters"), { ...valid, provenance: { forged: true } })).statusCode).toBe(400);
    expect((await request("POST", url("characters"), {
      ...valid,
      idempotencyKey: "wrong-project",
      referenceAssetIds: [otherProjectImageId],
    })).statusCode).toBe(404);
    expect((await request("POST", url("characters"), {
      ...valid,
      idempotencyKey: "wrong-media",
      referenceAssetIds: [projectVideoId],
    })).statusCode).toBe(400);
  });

  it("creates an ordered immutable pack and exposes it to viewers", async () => {
    const payload = {
      idempotencyKey: "ada-v1",
      name: "  Ada  ",
      description: "Reference fixture",
      referenceAssetIds: [sharedReferenceId, projectImageId],
    };
    const created = await request("POST", url("characters"), payload);
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      projectId,
      name: "Ada",
      description: "Reference fixture",
      repeated: false,
      referencePack: {
        version: 1,
        references: [
          { ordinal: 0, assetId: sharedReferenceId, assetProjectId: null, assetMediaType: "reference" },
          { ordinal: 1, assetId: projectImageId, assetProjectId: projectId, assetMediaType: "image" },
        ],
      },
    });
    const characterId = created.json().id;
    const element = (await pool.query(
      "SELECT kind FROM elements WHERE workspace_id=$1 AND id=$2",
      [workspaceId, created.json().elementId],
    )).rows[0];
    expect(element.kind).toBe("character");

    await pool.query(
      "UPDATE assets SET sha256=$1,metadata=$2 WHERE workspace_id=$3 AND project_id=$4 AND id=$5",
      ["changed".padEnd(64, "0"), JSON.stringify({ changed: true }), workspaceId, projectId, projectImageId],
    );
    const detail = await request("GET", url(`characters/${characterId}`), undefined, viewerCookie);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().referencePack.references[1].assetSha256).not.toContain("changed");
    expect(detail.json().referencePack.references[1].assetMetadata).toMatchObject({ source: "project.png" });
    const list = await request("GET", url("characters"), undefined, viewerCookie);
    expect(list.statusCode).toBe(200);
    expect(list.json().map((record: { id: string }) => record.id)).toContain(characterId);
    expect((await request("GET", url(`characters/${characterId}`, otherProjectId), undefined, viewerCookie)).statusCode).toBe(404);

    const foreignProjectId = randomUUID();
    await pool.query(
      "INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'Foreign',$3)",
      [foreignProjectId, foreignWorkspaceId, (await pool.query("SELECT user_id FROM memberships WHERE workspace_id=$1", [foreignWorkspaceId])).rows[0].user_id],
    );
    expect((await request(
      "GET",
      url(`characters/${characterId}`, foreignProjectId, foreignWorkspaceId),
      undefined,
      foreignCookie,
    )).statusCode).toBe(404);

    await expect(pool.query(
      "UPDATE character_reference_snapshots SET asset_sha256=$1 WHERE workspace_id=$2 AND character_id=$3 AND ordinal=0",
      ["forged".padEnd(64, "0"), workspaceId, characterId],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query(
      "DELETE FROM character_reference_snapshots WHERE workspace_id=$1 AND character_id=$2 AND ordinal=0",
      [workspaceId, characterId],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("returns the original record for identical retries and conflicts on payload changes", async () => {
    const payload = {
      idempotencyKey: "retry-fixture",
      name: "Retry",
      referenceAssetIds: [sharedReferenceId],
    };
    const first = await request("POST", url("characters"), payload);
    const repeated = await request("POST", url("characters"), payload);
    expect(first.statusCode).toBe(200);
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ id: first.json().id, elementId: first.json().elementId, repeated: true });
    expect((await request("POST", url("characters"), { ...payload, name: "Changed" })).statusCode).toBe(409);
  });

  it("serializes simultaneous identical and conflicting creates", async () => {
    const identical = {
      idempotencyKey: "concurrent-identical",
      name: "Concurrent",
      referenceAssetIds: [sharedReferenceId],
    };
    const identicalResponses = await Promise.all([
      request("POST", url("characters"), identical),
      request("POST", url("characters"), identical),
    ]);
    expect(identicalResponses.map(response => response.statusCode)).toEqual([200, 200]);
    expect(identicalResponses.map(response => response.json().repeated).sort()).toEqual([false, true]);
    expect(new Set(identicalResponses.map(response => response.json().id)).size).toBe(1);
    const identicalId = identicalResponses[0].json().id;
    expect((await pool.query(
      "SELECT count(*) AS n FROM character_records WHERE workspace_id=$1 AND project_id=$2 AND idempotency_key=$3",
      [workspaceId, projectId, identical.idempotencyKey],
    )).rows[0].n).toBe("1");
    expect((await pool.query(
      `SELECT count(*) AS n FROM elements e
        JOIN character_records c ON c.workspace_id=e.workspace_id AND c.element_id=e.id
       WHERE c.workspace_id=$1 AND c.project_id=$2 AND c.id=$3`,
      [workspaceId, projectId, identicalId],
    )).rows[0].n).toBe("1");
    expect((await pool.query(
      "SELECT count(*) AS n FROM character_reference_snapshots WHERE workspace_id=$1 AND character_id=$2",
      [workspaceId, identicalId],
    )).rows[0].n).toBe("1");

    const conflictKey = "concurrent-conflict";
    const conflicts = await Promise.all([
      request("POST", url("characters"), { ...identical, idempotencyKey: conflictKey, name: "First" }),
      request("POST", url("characters"), { ...identical, idempotencyKey: conflictKey, name: "Second" }),
    ]);
    expect(conflicts.map(response => response.statusCode).sort()).toEqual([200, 409]);
    expect((await pool.query(
      "SELECT count(*) AS n FROM character_records WHERE workspace_id=$1 AND project_id=$2 AND idempotency_key=$3",
      [workspaceId, projectId, conflictKey],
    )).rows[0].n).toBe("1");
  });

  it("prevents deleting a project whose only project-bound resource is a character", async () => {
    const project = await request("POST", `/api/v1/workspaces/${workspaceId}/projects`, { name: "Character only" });
    const characterOnlyProjectId = project.json().id;
    const created = await request("POST", url("characters", characterOnlyProjectId), {
      idempotencyKey: "guard-fixture",
      name: "Guarded",
      referenceAssetIds: [sharedReferenceId],
    });
    expect(created.statusCode).toBe(200);
    const deletion = await request("DELETE", `/api/v1/workspaces/${workspaceId}/projects/${characterOnlyProjectId}`);
    expect(deletion.statusCode).toBe(409);
    expect(deletion.json().error).toContain("characters");
  });
  it("counts verified reference runs and distinct completed shots through asset lineage",async()=>{
    const created=await request("POST",url("characters"),{idempotencyKey:randomUUID(),name:"Usage fixture",referenceAssetIds:[projectImageId,sharedReferenceId]});
    expect(created.statusCode).toBe(200);
    const character=created.json(),snapshots=Object.fromEntries(character.referencePack.references.map((ref:any,index:number)=>[`reference_${index}`,{validationVersion:1,elementKind:"character",elementId:character.elementId,assetId:ref.assetId,assetSha256:ref.assetSha256}]));
    expect(character.usage).toEqual({referenceRuns:0,completedShots:0});
    const output=await Promise.all(Array.from({length:5},(_,i)=>addAsset(projectId,"image",`usage-${i}.png`)));
    async function run(inputs:Record<string,string>,proof:unknown,state="succeeded",outputs:string[]=[],project=projectId){
      const id=randomUUID();await pool.query(`INSERT INTO runs(id,workspace_id,project_id,created_by,capability_id,capability_version,route_id,state,invocation,request_hash,idempotency_key,output_ids) VALUES($1,$2,$3,$4,'usage-fixture','1','local',$5,$6,'usage',$7,$8)`,[id,workspaceId,project,ownerId,state,JSON.stringify({inputs,...(proof===undefined?{}:{elementInputSnapshots:proof})}),randomUUID(),JSON.stringify(outputs)]);return id;
    }
    const seed=await run({},snapshots,"succeeded",[output[0]]),chain=[seed];
    for(let i=1;i<5;i++)chain.push(await run({source_image:output[i-1]},undefined,"succeeded",[output[i]]));
    // An editor composite is linked to its source by parent_id, then used as
    // the input of a later run. Character lineage must cross that export.
    const composite=await addAsset(projectId,"image","composite-export.png"),compositeOutput=await addAsset(projectId,"image","composite-run.png");
    await pool.query("UPDATE assets SET parent_id=$1 WHERE workspace_id=$2 AND id=$3",[output[4],workspaceId,composite]);
    const compositeRun=await run({source_image:composite},undefined,"succeeded",[compositeOutput]);
    // Cyclic legacy provenance must terminate without multiplying usage.
    await pool.query(`UPDATE runs SET invocation=jsonb_set(invocation,'{inputs}',$1::jsonb) WHERE id=$2`,[JSON.stringify({source_image:output[4]}),seed]);
    const failed=await run({source_image:output[0]},snapshots,"failed",[output[1]]);
    await run({},snapshots,"succeeded",[]);
    await run({},Object.fromEntries(Object.entries(snapshots).map(([port,value])=>[port,{...(value as object),assetSha256:"wrong"}])) ,"succeeded",[output[0]]);
    await run({reference_image:projectImageId},undefined,"succeeded",[output[0]]);
    await run({},"legacy-invalid-proof","succeeded",[output[0]]);
    await run({},snapshots,"succeeded",[output[0]],otherProjectId);
    const worker=randomUUID(),revision=randomUUID(),boards=[randomUUID(),randomUUID()],plan=randomUUID(),otherPlan=randomUUID(),compositePlan=randomUUID();
    await pool.query(`INSERT INTO workers(id,workspace_id,name,origin,enabled) VALUES($1,$2,'Usage fixture','http://127.0.0.1:29999',false)`,[worker,workspaceId]);
    await pool.query(`INSERT INTO workflow_revisions(id,workspace_id,capability_id,version,sha256,manifest,graph) VALUES($1,$2,'usage-fixture','1',$3,'{}','{}')`,[revision,workspaceId,randomBytes(32).toString("hex")]);
    for(const board of boards)await pool.query(`INSERT INTO storyboards(id,workspace_id,project_id,name,created_by) VALUES($1,$2,$3,'Usage fixture',$4)`,[board,workspaceId,projectId,ownerId]);
    await pool.query(`INSERT INTO storyboard_still_takes(id,workspace_id,storyboard_id,plan_key,source_revision,ordinal,prompt,snapshot,child_run_id,batch_key,request_hash) VALUES($1,$2,$3,$4,1,0,'Usage','{}',$5,$6,'usage')`,[randomUUID(),workspaceId,boards[0],plan,seed,randomUUID()]);
    async function shot(board:string,key:string,child:string){const render=randomUUID();await pool.query(`INSERT INTO storyboard_renders(id,workspace_id,project_id,storyboard_id,revision,worker_id,created_by,idempotency_key,request_hash,assembly,state) VALUES($1,$2,$3,$4,1,$5,$6,$7,'usage','{}','succeeded')`,[render,workspaceId,projectId,board,worker,ownerId,randomUUID()]);await pool.query(`INSERT INTO storyboard_render_shots(workspace_id,render_id,ordinal,snapshot,prepared,workflow_revision_id,child_run_id) VALUES($1,$2,0,$3,'{}',$4,$5)`,[workspaceId,render,JSON.stringify({planKey:key}),revision,child]);}
    await shot(boards[0],plan,chain[1]);await shot(boards[0],plan,chain[2]);
    await shot(boards[0],otherPlan,chain[3]);await shot(boards[1],plan,chain[4]);
    await shot(boards[0],compositePlan,compositeRun);
    await shot(boards[0],randomUUID(),failed);
    const detail=await request("GET",url(`characters/${character.id}`));
    expect(detail.statusCode).toBe(200);expect(detail.json().usage).toEqual({referenceRuns:1,completedShots:4});
    const list=await request("GET",url("characters"),undefined,viewerCookie);
    expect(list.statusCode).toBe(200);expect(list.json().find((record:any)=>record.id===character.id).usage).toEqual(detail.json().usage);
  });

});

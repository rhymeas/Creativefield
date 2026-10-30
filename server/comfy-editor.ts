import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { HttpError, member } from "./auth";
import { apiToUi, type EditorWorkflow } from "../src/workflow/api-to-ui";
import type { ObjectInfo } from "../src/workflow/ui-to-api";
import { runGraph } from "./runs";
import {buildReplaceInspectionGraph} from "../src/capabilities/replace-inspection";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The name a run's copy loads under, so saving in the editor can never overwrite a feature's own workflow. */
export const runFileName = (runId: string) => `ComfyField run ${runId.slice(0, 8)}`;

/**
 * apiToUi numbers nodes 1..n. ComfyUI reports its progress by the submitted node id, so each node takes
 * back the id it had in the run's graph: that is what makes the editor's own highlight and progress bar
 * land on the node the run is executing. Nodes apiToUi added (inline primitives) take a free number.
 */
export function withSubmittedIds(workflow: EditorWorkflow): EditorWorkflow {
  const submitted = workflow.extra.comfyfield.ids, ids = new Map<number, number>(), taken = new Set<number>();
  for (const node of workflow.nodes) {
    const key = submitted[String(node.id)];
    if (!key || !/^\d{1,9}$/.test(key) || taken.has(Number(key))) continue;
    ids.set(node.id, Number(key));
    taken.add(Number(key));
  }
  let free = 1;
  for (const node of workflow.nodes) {
    if (ids.has(node.id)) continue;
    while (taken.has(free)) free++;
    ids.set(node.id, free);
    taken.add(free);
  }
  const nodes = workflow.nodes.map(node => ({ ...node, id: ids.get(node.id)! }));
  const links = workflow.links.map(([id, source, slot, target, targetSlot, type]) =>
    [id, ids.get(source) ?? source, slot, ids.get(target) ?? target, targetSlot, type] as EditorWorkflow["links"][number]);
  return {
    ...workflow,
    nodes,
    links,
    last_node_id: Math.max(0, ...nodes.map(node => node.id)),
    extra: { ...workflow.extra, comfyfield: { ids: Object.fromEntries(nodes.map((node, index) => [String(node.id), submitted[String(workflow.nodes[index].id)] ?? String(node.id)])) } },
  };
}

/** Runs only inside the isolated ComfyUI origin. Opens the graph a run submitted as a copy; it never queues a prompt. */
export const RUN_SCRIPT = `const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function comfyApp() {
  return (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app) || window.app;
}

async function whenReady(timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const app = comfyApp();
    if (app && app.graph && typeof app.loadGraphData === "function") return app;
    await new Promise(function (resolve) { setTimeout(resolve, 300); });
  }
  throw new Error("The node editor did not become ready.");
}

/** Waits until the workflow store is idle (session restore done), then a moment longer for the last tab switch. */
async function settled(app, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const store = app.extensionManager && app.extensionManager.workflow;
    if (store && store.activeWorkflow && !store.isBusy && !store.isSyncLoading && !store.activeWorkflow.isLoading) break;
    await new Promise(function (resolve) { setTimeout(resolve, 300); });
  }
  await new Promise(function (resolve) { setTimeout(resolve, 1200); });
}

async function open() {
  const run = new URLSearchParams(location.search).get("comfyfield_run");
  const workspace = /^\\/comfy\\/([0-9a-f-]{36})\\//i.exec(location.pathname);
  if (!run || !RUN_ID.test(run) || !workspace) return;
  const app = await whenReady(30000);
  const response = await fetch("/comfyfield-run-graph/" + workspace[1] + "/" + run, { credentials: "same-origin" });
  if (!response.ok) throw new Error("Run graph unavailable (" + response.status + ")");
  const data = await response.json();
  // The editor restores the previous session's tabs after start-up; loading before that finishes loses our tab.
  await settled(app);
  for (let attempt = 0; attempt < 2; attempt++) {
    await app.loadGraphData(data.workflow, true, true, data.name);
    await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    if ((app.graph.serialize().links || []).length >= data.workflow.links.length) return;
  }
}

if (typeof window !== "undefined") open().catch(function (error) { console.warn("[ComfyField]", error.message); });
`;

/** The node types the run's worker has, needed to draw its graph in the editor. */
async function objectInfo(pool: Pool, workspaceId: string): Promise<ObjectInfo> {
  const worker = (await pool.query("SELECT origin FROM workers WHERE workspace_id=$1 AND enabled=true AND kind='local' ORDER BY (COALESCE(inventory->>'online','false')='true') DESC,name,id LIMIT 1", [workspaceId])).rows[0] as { origin?: string } | undefined;
  if (!worker?.origin) throw new HttpError(503, "No enabled ComfyUI worker is registered for this workspace");
  let response: Response;
  try { response = await fetch(`${worker.origin}/object_info`, { signal: AbortSignal.timeout(30_000) }); }
  catch { throw new HttpError(502, "The ComfyUI node editor is not reachable"); }
  if (!response.ok) throw new HttpError(502, "The ComfyUI node editor is not reachable");
  return await response.json() as ObjectInfo;
}

/**
 * The run view of the isolated editor: the script it loads and the graph a run submitted, as a read-only copy.
 * Both are answered only inside the editor origin; the graph is the run's own compiled graph and nothing else.
 */
export async function referenceInspectionRoutes(app:FastifyInstance,pool:Pool){
  app.get("/api/v1/workspaces/:workspaceId/runs/:runId/reference-inspection",async(request,reply)=>{
    const {workspaceId,runId}=request.params as {workspaceId:string;runId:string};
    if(!UUID.test(workspaceId)||!UUID.test(runId))throw new HttpError(400,"Unknown run");
    await member(pool,request,workspaceId);
    const run=await runGraph(pool,workspaceId,runId);
    if(!run)throw new HttpError(404,"Run not found");
    if(run.capabilityId!=="scail2-character-replace"||!run.graph)throw new HttpError(422,"This run has no saved SCAIL preparation graph");
    try{return reply.header("Cache-Control","no-store").send({runId,graph:buildReplaceInspectionGraph(run.graph)});}
    catch(error){throw new HttpError(422,(error as Error).message);}
  });
}

export async function runGraphRoutes(app: FastifyInstance, pool: Pool) {
  await referenceInspectionRoutes(app,pool);
  app.get("/comfyfield-run.js", async (_request, reply) =>
    reply.type("text/javascript; charset=utf-8").header("Cache-Control", "no-cache").send(RUN_SCRIPT));
  app.get("/comfyfield-run-graph/:workspaceId/:runId", async (request, reply) => {
    const { workspaceId, runId } = request.params as { workspaceId: string; runId: string };
    if (!UUID.test(workspaceId) || !UUID.test(runId)) throw new HttpError(400, "Unknown run");
    await member(pool, request, workspaceId);
    const run = await runGraph(pool, workspaceId, runId);
    if (!run) throw new HttpError(404, "Run not found");
    if (!run.graph) throw new HttpError(404, "This run has not compiled its graph yet");
    let workflow: EditorWorkflow;
    try { workflow = withSubmittedIds(apiToUi(run.graph, await objectInfo(pool, workspaceId))); }
    catch (error) { throw new HttpError(422, `This run's graph cannot be opened on this worker: ${(error as Error).message}`); }
    return reply.header("Cache-Control", "no-store").send({ name: runFileName(runId), promptId: run.promptId, workflow });
  });
}

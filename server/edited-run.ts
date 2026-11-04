import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { ApiGraph } from "../src/workflow/build";
import { apiToUi } from "../src/workflow/api-to-ui";
import { uiToApi, type ObjectInfo } from "../src/workflow/ui-to-api";
import type { CapabilityManifestV2, Invocation } from "../src/capabilities/types";
import { assertLocalGraphPolicy, OPENJUTSU_ADVANCED_CLASSES } from "../src/capabilities/policy";
import { member, HttpError } from "./auth";
import { withSubmittedIds } from "./comfy-editor";
import { publicGraph } from "./runs";
import { parseWorkflow } from "./hub-source";
import { restoreFeatureIds } from "./feature-edit";
import { canonical, enqueuePreparedRun, publicColumns } from "./run-submission";
import { hashToken } from "./crypto";
import { transaction } from "./db";
import { exactImageArtifactSlotSpecs } from "./image-artifacts";

const mediaFields: Record<string, string[]> = {
  LoadImage: ["image"], LoadVideo: ["file", "video"], VHS_LoadVideo: ["video"],
  LoadAudio: ["audio"], RecordAudio: ["audio"], Painter: ["image"],
};

/** Retain the run's output contract and permit only media already belonging to
 * the original run. New project assets need to pass the normal asset admission. */
export function validateRunEdit(original: ApiGraph, edited: ApiGraph, manifest: CapabilityManifestV2): void {
  assertLocalGraphPolicy(edited, manifest.id === "openjutsu-h3-advanced" ? OPENJUTSU_ADVANCED_CLASSES : undefined);
  const media = new Set<string>();
  for (const node of Object.values(original)) for (const field of mediaFields[node.class_type] ?? []) {
    const value = node.inputs[field]; if (typeof value === "string") media.add(value);
  }
  for (const [id, node] of Object.entries(edited)) {
    for (const field of mediaFields[node.class_type] ?? []) {
      const value = node.inputs[field];
      if (typeof value === "string" && !media.has(value)) throw new Error(`Choose project media through the app before changing ${id}.${field}.`);
    }
    // New model selections must go through the app's model admission, rather
    // than quietly changing the model family when a graph is rerun.
    if (/Loader/.test(node.class_type) && !mediaFields[node.class_type]) {
      for (const [field,value] of Object.entries(node.inputs)) {
        if (typeof value !== "string") continue;
        const allowed = Object.values(original).some(before => before.class_type === node.class_type && before.inputs[field] === value);
        if (!allowed) throw new Error(`Choose installed models through the app before changing ${id}.${field}.`);
      }
    }
  }
  for (const [id,node] of Object.entries(original)) {
    if (!/^(Save|Preview)/.test(node.class_type) && node.class_type !== "MiniMaxH3ChainAssemble") continue;
    if (edited[id]?.class_type !== node.class_type) throw new Error(`Keep the original result node ${id} (${node.class_type}).`);
  }
  for (const contract of [manifest.outputContract, manifest.motionContract, manifest.replaceContract, manifest.voiceContract, manifest.posePreviewContract]) {
    const id = contract?.artifactNode;
    if (id && original[id] && edited[id]?.class_type !== original[id].class_type) throw new Error(`Keep the original result node ${id}.`);
  }
}

export async function editedRunRoutes(app: FastifyInstance, pool: Pool) {
  app.get("/api/v1/workspaces/:workspaceId/runs/:runId/edited", async request => {
    const {workspaceId}=z.object({workspaceId:z.uuid(),runId:z.uuid()}).parse(request.params);
    await member(pool,request,workspaceId);
    return {available:true};
  });
  app.post("/api/v1/workspaces/:workspaceId/runs/:runId/edited", async request => {
    const {workspaceId,runId}=z.object({workspaceId:z.uuid(),runId:z.uuid()}).parse(request.params);
    const body=z.object({json:z.string().min(2).max(5_000_000),idempotencyKey:z.string().min(8).max(128).refine(key=>!key.startsWith("storyboard:")&&!key.startsWith("storyboard-still:")&&!key.startsWith("video-extension:")&&!key.startsWith("pose-preview:"),"Internal execution prefixes are reserved")}).strict().parse(request.body);
    const user=await member(pool,request,workspaceId,"creator");
    const source=(await pool.query(`SELECT r.*,w.kind AS worker_kind,w.origin,wr.manifest FROM runs r
      JOIN workers w ON w.workspace_id=r.workspace_id AND w.id=r.worker_id AND w.enabled=true
      JOIN workflow_revisions wr ON wr.workspace_id=r.workspace_id AND wr.id=r.workflow_revision_id
      WHERE r.workspace_id=$1 AND r.id=$2 AND r.deleted_at IS NULL`,[workspaceId,runId])).rows[0];
    if(!source?.graph || source.worker_kind!=="local") throw new HttpError(422,"This run has no local graph available to edit.");
    const response=await fetch(`${source.origin}/object_info`,{signal:AbortSignal.timeout(30_000),redirect:"error"}).catch(()=>null);
    if(!response?.ok)throw new HttpError(502,"The original ComfyUI worker is not answering.");
    const info=await response.json() as ObjectInfo, original=publicGraph(source.graph as ApiGraph);
    const ui=parseWorkflow(body.json), ids=(ui as {extra?:{comfyfield?:{ids?:Record<string,string>}}}).extra?.comfyfield?.ids;
    const expected=withSubmittedIds(apiToUi(original,info)).extra.comfyfield.ids;
    if(canonical(ids)!==canonical(expected))throw new HttpError(422,"Open this run's graph before starting a new run.");
    let edited:ApiGraph;
    try {
      edited=publicGraph(restoreFeatureIds(uiToApi(ui,info),ids));
      validateRunEdit(original,edited,source.manifest as CapabilityManifestV2);
    } catch(error) { throw new HttpError(422,`The edited graph cannot be run: ${(error as Error).message}`); }
    const requestHash=hashToken(canonical({runId,json:body.json}));
    return transaction(pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${workspaceId}/${body.idempotencyKey}`]);
      const old=(await client.query(`SELECT ${publicColumns},request_hash FROM runs WHERE workspace_id=$1 AND idempotency_key=$2`,[workspaceId,body.idempotencyKey])).rows[0];
      if(old){if(old.request_hash!==requestHash)throw new HttpError(409,"Idempotency key was already used for a different request");delete old.request_hash;return old;}
      const locked=(await client.query("SELECT graph FROM runs WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",[workspaceId,runId])).rows[0];
      if(!locked?.graph || canonical(publicGraph(locked.graph))!==canonical(original))throw new HttpError(409,"The original run changed; reopen its graph.");
      const manifest=source.manifest as CapabilityManifestV2;
      const prepared={projectId:source.project_id,workerId:source.worker_id,revisionId:source.workflow_revision_id,invocation:source.invocation as Invocation,
        ...(manifest.imageArtifacts?{imageArtifactSpecs:exactImageArtifactSlotSpecs(manifest.imageArtifacts)}:{})};
      const queued=await enqueuePreparedRun(client,workspaceId,user.id,prepared,body.idempotencyKey,requestHash,{scene:source.scene??1,shot:source.shot??1});
      await client.query("INSERT INTO run_graph_edits(workspace_id,run_id,source_run_id,original_graph,edited_graph) VALUES($1,$2,$3,$4,$5)",[workspaceId,queued.id,runId,JSON.stringify(original),JSON.stringify(edited)]);
      return queued;
    });
  });
}

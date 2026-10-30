import type { Pool } from "pg";
import { HttpError, type Principal, type Role } from "./auth";
import { transaction } from "./db";
import type { DiskStore } from "./storage";
import type { ApiGraph } from "../src/workflow/build";

// A run is still the queue's until it settles; only a finished, failed or canceled one may be deleted.
const activeStates = ["pending","submitting","submission_unknown","queued","running","cancel_requested"];

/** A run's own compiled graph, as handed to ComfyUI. Caller must first authorize membership of the workspace. */
export type RunGraph = { graph: ApiGraph | null; promptId: string | null; capabilityId: string };

/** The exact API graph this run submitted, with anything that could be a credential removed. */
export async function runGraph(pool: Pool, workspaceId: string, id: string): Promise<RunGraph | undefined> {
  const row = (await pool.query("SELECT graph,remote_id,capability_id FROM runs WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL", [workspaceId, id])).rows[0];
  if (!row) return undefined;
  return {
    graph: row.graph && typeof row.graph === "object" ? publicGraph(row.graph as ApiGraph) : null,
    promptId: typeof row.remote_id === "string" ? row.remote_id : null,
    capabilityId: String(row.capability_id),
  };
}

/** A key is a secret when its last name part is one: "api_key", "auth.token", "hf-secret". */
const SECRET_NAME = /(^|[._-])(api[_-]?key|key|token|secret|password|passphrase|authorization|credentials?)$/i;

/** The graph is shown to the people who may read the run; no key, token or password value travels with it. */
export function publicGraph(graph: ApiGraph): ApiGraph {
  return Object.fromEntries(Object.entries(graph).map(([id, node]) => [id, {
    ...node,
    inputs: Object.fromEntries(Object.entries(node.inputs ?? {}).filter(([name]) => !SECRET_NAME.test(name))),
  }]));
}

/** Caller must first authorize creator access to this workspace, and own the run unless an admin. */
export async function deleteRun(pool: Pool, store: DiskStore, workspaceId: string, id: string, user: Principal & { role: Role }) {
  const outputIds = await transaction<string[]>(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`run-delete/${workspaceId}/${id}`]);
    const run = (await client.query("SELECT state,created_by,output_ids FROM runs WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE", [workspaceId, id])).rows[0];
    if (!run) throw new HttpError(404, "Run not found");
    if (user.role !== "admin" && run.created_by !== user.id) throw new HttpError(403, "Only the run owner or an administrator may delete this run");
    if (activeStates.includes(run.state)) throw new HttpError(409, "Cancel this run first.");
    // The record stays as history; only its visibility and its own output files go.
    await client.query("UPDATE runs SET deleted_at=now() WHERE workspace_id=$1 AND id=$2", [workspaceId, id]);
    const outputs: unknown[] = Array.isArray(run.output_ids) ? run.output_ids : [];
    return outputs.filter((assetId): assetId is string => typeof assetId === "string");
  });
  for (const assetId of new Set(outputIds)) await removeOutput(pool, store, workspaceId, id, assetId);
}

/** An output leaves the library like DELETE assets/:id does, unless another run or a storyboard needs it. */
async function removeOutput(pool: Pool, store: DiskStore, workspaceId: string, runId: string, assetId: string) {
  let receipt: { storage_key: string } | undefined;
  try {
    receipt = await transaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`asset-delete/${workspaceId}/${assetId}`]);
      const asset = (await client.query("SELECT storage_key,project_id,name FROM assets WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [workspaceId, assetId])).rows[0];
      if (!asset) return undefined;
      const used = await client.query(`SELECT 1 FROM runs WHERE workspace_id=$1 AND id<>$2 AND deleted_at IS NULL AND output_ids @> jsonb_build_array($3::uuid::text)
        UNION ALL SELECT 1 FROM shot_assets WHERE workspace_id=$1 AND asset_id=$3::uuid
        UNION ALL SELECT 1 FROM storyboard_render_shots WHERE workspace_id=$1 AND output_asset_id=$3::uuid
        UNION ALL SELECT 1 FROM storyboard_renders WHERE workspace_id=$1 AND output_asset_id=$3::uuid
        UNION ALL SELECT 1 FROM storyboard_still_takes WHERE workspace_id=$1 AND approved_asset_id=$3::uuid LIMIT 1`, [workspaceId, runId, assetId]);
      if (used.rowCount) return undefined;
      // The receipt survives a filesystem failure, exactly as it does for DELETE assets/:id.
      await client.query("INSERT INTO asset_deletions(workspace_id,asset_id,project_id,name,storage_key) VALUES($1,$2,$3,$4,$5)", [workspaceId, assetId, asset.project_id, asset.name, asset.storage_key]);
      await client.query("DELETE FROM assets WHERE workspace_id=$1 AND id=$2", [workspaceId, assetId]);
      return { storage_key: asset.storage_key };
    });
  } catch (error) {
    // A derived file, an element, a character or another run's input still owns this file: keep it.
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23503") return;
    throw error;
  }
  if (!receipt) return;
  try { await store.remove(workspaceId, receipt.storage_key); }
  catch (error) {
    // A file that is already gone is finished; anything else leaves the receipt for a retry.
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) return;
  }
  await pool.query("UPDATE asset_deletions SET completed_at=now() WHERE workspace_id=$1 AND asset_id=$2", [workspaceId, assetId]);
}

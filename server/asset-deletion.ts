import type { Pool, PoolClient } from "pg";
import { HttpError } from "./auth";
import { transaction } from "./db";
import type { DiskStore } from "./storage";

export type DeletingUser = { id: string; role: string };
export type DeletionResult = { removed: true } | { removed: false; hidden: true; reason: string };

/** Take the file out of every run result that lists it. Results of someone else's run are only changed by an
 *  administrator, the same rule as deleting a run. */
async function leaveRunResults(client: PoolClient, workspaceId: string, id: string, user: DeletingUser) {
  const owners = (await client.query("SELECT DISTINCT created_by FROM runs WHERE workspace_id=$1 AND output_ids @> jsonb_build_array($2::uuid::text)", [workspaceId, id])).rows;
  if (user.role !== "admin" && owners.some(row => row.created_by !== user.id))
    throw new HttpError(403, "This file is a result of someone else's run. Only that person or an administrator can remove it.");
  await client.query("UPDATE runs SET output_ids=output_ids - ($2::uuid::text) WHERE workspace_id=$1 AND output_ids @> jsonb_build_array($2::uuid::text)", [workspaceId, id]);
}

/** Caller must first authorize creator access to this workspace. No scheduler.
 *  A file that a project item still needs (a run's input, a storyboard still, ...) cannot be deleted: it leaves the
 *  library and the results but keeps its bytes, and the answer says so instead of claiming a deletion. */
export async function deleteLibraryAsset(pool: Pool, store: DiskStore, workspaceId: string, id: string, user: DeletingUser): Promise<DeletionResult> {
  let receipt: { storage_key: string; completed_at: Date | null; hidden?: boolean };
  receipt = await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`asset-delete/${workspaceId}/${id}`]);
    const asset = (await client.query("SELECT storage_key,project_id,name FROM assets WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [workspaceId, id])).rows[0];
    if (!asset) {
      const prior = (await client.query("SELECT storage_key,completed_at FROM asset_deletions WHERE workspace_id=$1 AND asset_id=$2", [workspaceId, id])).rows[0];
      if (!prior) throw new HttpError(404, "Asset not found");
      return prior;
    }
    await leaveRunResults(client, workspaceId, id, user);
    await client.query("SAVEPOINT remove_asset");
    try {
      await client.query("INSERT INTO asset_deletions(workspace_id,asset_id,project_id,name,storage_key) VALUES($1,$2,$3,$4,$5)", [workspaceId, id, asset.project_id, asset.name, asset.storage_key]);
      await client.query("DELETE FROM assets WHERE workspace_id=$1 AND id=$2", [workspaceId, id]);
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "23503")) throw error;
      // Still referenced: undo only the deletion. Leaving the results (above the savepoint) stays done.
      await client.query("ROLLBACK TO SAVEPOINT remove_asset");
      await client.query("UPDATE assets SET metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),'{libraryHidden}','true'::jsonb) WHERE workspace_id=$1 AND id=$2", [workspaceId, id]);
      return { storage_key: asset.storage_key, completed_at: null, hidden: true };
    }
    return { storage_key: asset.storage_key, completed_at: null };
  });
  if (receipt.hidden)
    return { removed: false, hidden: true, reason: "A project item still uses this file, so its stored copy is kept. It no longer shows in the library or the results." };
  if (!receipt.completed_at) {
    try { await store.remove(workspaceId, receipt.storage_key); }
    catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT")
        throw new HttpError(503, "File removal needs another try. Retry deletion to finish cleaning up its stored copy.");
    }
    await pool.query("UPDATE asset_deletions SET completed_at=now() WHERE workspace_id=$1 AND asset_id=$2", [workspaceId, id]);
  }
  return { removed: true };
}

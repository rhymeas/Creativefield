import type { Pool } from "pg";
import { HttpError } from "./auth";
import { transaction } from "./db";
import type { DiskStore } from "./storage";

/** Caller must first authorize creator access to this workspace. No scheduler. */
export async function deleteLibraryAsset(pool: Pool, store: DiskStore, workspaceId: string, id: string) {
  let receipt: { storage_key: string; completed_at: Date | null };
  try {
    receipt = await transaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`asset-delete/${workspaceId}/${id}`]);
      const asset = (await client.query("SELECT storage_key,project_id,name FROM assets WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [workspaceId, id])).rows[0];
      if (!asset) {
        const prior = (await client.query("SELECT storage_key,completed_at FROM asset_deletions WHERE workspace_id=$1 AND asset_id=$2", [workspaceId, id])).rows[0];
        if (!prior) throw new HttpError(404, "Asset not found");
        return prior;
      }
      // Legacy run outputs live in JSON rather than a foreign-key table.
      const output = await client.query("SELECT id FROM runs WHERE workspace_id=$1 AND output_ids @> jsonb_build_array($2::uuid::text) LIMIT 1", [workspaceId, id]);
      if (output.rowCount) throw new HttpError(409, "This file is still used by a run. Remove that reference before deleting it.");
      await client.query("INSERT INTO asset_deletions(workspace_id,asset_id,project_id,name,storage_key) VALUES($1,$2,$3,$4,$5)", [workspaceId, id, asset.project_id, asset.name, asset.storage_key]);
      // FK violations roll back both removal and receipt (inputs, shots, layers,
      // derived assets, elements and other relational references stay protected).
      await client.query("DELETE FROM assets WHERE workspace_id=$1 AND id=$2", [workspaceId, id]);
      return { storage_key: asset.storage_key, completed_at: null };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23503")
      throw new HttpError(409, "This file is still used by a project item. Remove that reference before deleting it.");
    throw error;
  }
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

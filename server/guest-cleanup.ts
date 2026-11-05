/* A hosted try-out (GUEST_PER_BROWSER=1) keeps a guest's uploads and results only while they use it.
   A guest not seen for GUEST_IDLE_HOURS (default 24) loses the whole workspace: its files folder and
   every row that names it, then the guest user and their sessions. Their browser starts over as a new
   guest on the next visit. A workspace with a run still in flight waits for the next sweep. */

import { rm } from "node:fs/promises";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { GUEST_DOMAIN } from "./auth";
import { transaction } from "./db";
import { forgetBrowserCloudKey } from "./cloud-keys";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ACTIVE_RUN = ["pending","submitting","submission_unknown","queued","running","cancel_requested"];

export const guestIdleHours = () => {
  const hours = Number(process.env.GUEST_IDLE_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours : 24;
};

/** Every table in this schema with a workspace_id column, so tables added later are covered too. */
async function workspaceTables(client: PoolClient): Promise<string[]> {
  const rows = (await client.query("SELECT table_name FROM information_schema.columns WHERE table_schema=current_schema() AND column_name='workspace_id' AND table_name<>'memberships' AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE')")).rows;
  return rows.map(row => String(row.table_name));
}

async function deleteGuest(pool: Pool, storageRoot: string, workspaceId: string, userId: string) {
  await transaction(pool, async client => {
    /* Provenance tables are append-only by trigger; this flag lets the trigger allow a delete for this
       transaction only (migration 035). The schema has no cascades, so a table whose rows are still
       referenced is retried after the tables that reference it are empty. */
    await client.query("SELECT set_config('creativefield.guest_cleanup', 'on', true)");
    let pending = [...await workspaceTables(client), "memberships"];
    while (pending.length) {
      const blocked: string[] = [];
      for (const table of pending) {
        await client.query("SAVEPOINT guest_table");
        try { await client.query(`DELETE FROM "${table.replace(/"/g, '""')}" WHERE workspace_id=$1`, [workspaceId]); await client.query("RELEASE SAVEPOINT guest_table"); }
        catch (error) { if ((error as { code?: string }).code !== "23503") throw error; await client.query("ROLLBACK TO SAVEPOINT guest_table"); blocked.push(table); }
      }
      if (blocked.length === pending.length) throw new Error(`rows still referenced in ${blocked.join(", ")}`);
      pending = blocked;
    }
    await client.query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
    await client.query("DELETE FROM sessions WHERE user_id=$1", [userId]);
    await client.query("DELETE FROM users WHERE id=$1 AND email LIKE $2", [userId, `%${GUEST_DOMAIN}`]);
  });
  forgetBrowserCloudKey(workspaceId);
  if (UUID.test(workspaceId)) await rm(path.join(storageRoot, workspaceId), { recursive: true, force: true });
}

/** Deletes every idle guest's workspace. Returns how many were removed. */
export async function sweepIdleGuests(pool: Pool, storageRoot: string, idleHours = guestIdleHours()): Promise<number> {
  const idle = (await pool.query(
    `SELECT m.workspace_id, u.id AS user_id FROM users u JOIN memberships m ON m.user_id=u.id
     WHERE u.email LIKE $1 AND COALESCE(u.last_seen_at,u.created_at) < now() - make_interval(hours => $2::int)
       AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.workspace_id=m.workspace_id AND o.user_id<>u.id)
       AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.workspace_id=m.workspace_id AND r.state = ANY($3))`,
    [`%${GUEST_DOMAIN}`, Math.ceil(idleHours), ACTIVE_RUN])).rows;
  let removed = 0;
  for (const row of idle) {
    try { await deleteGuest(pool, storageRoot, row.workspace_id, row.user_id); removed++; }
    catch (error) { console.error(`Guest cleanup skipped a workspace: ${(error as Error).message}`); }
  }
  return removed;
}

/** Sweeps once an hour; the timer never keeps the process alive. */
export function startGuestCleanup(pool: Pool, storageRoot: string): { close: () => void } {
  const run = () => void sweepIdleGuests(pool, storageRoot).then(n => { if (n) console.info(`Guest cleanup removed ${n} idle workspace(s)`); }).catch(error => console.error(`Guest cleanup failed: ${(error as Error).message}`));
  const first = setTimeout(run, 60_000), timer = setInterval(run, 60 * 60_000);
  first.unref(); timer.unref();
  return { close: () => { clearTimeout(first); clearInterval(timer); } };
}

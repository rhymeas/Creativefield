import type { Pool } from "pg";
import type { FastifyRequest } from "fastify";
import { hashPassword, hashToken, newId } from "./crypto";
import { transaction } from "./db";

export class HttpError extends Error { constructor(readonly statusCode: number, message: string) { super(message); } }
export type Principal = { id: string; email: string };
/** Every hosted guest's made-up address ends in this. */
export const GUEST_DOMAIN = "@guest.creativefield";
export type Role = "admin" | "creator" | "viewer";
export async function principal(pool: Pool, request: FastifyRequest): Promise<Principal> {
  const token = request.cookies.cf_session;
  if (!token || token.length > 128) throw new HttpError(401, "Sign in to your team workspace");
  const result = await pool.query("SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()", [hashToken(token)]);
  if (!result.rows[0]) throw new HttpError(401, "Session expired");
  /* A hosted try-out (GUEST_PER_BROWSER=1) only knows guests: a session from the old shared demo starts over as a guest. */
  if (process.env.GUEST_PER_BROWSER === "1") {
    if (!String(result.rows[0].email).endsWith(GUEST_DOMAIN)) throw new HttpError(401, "Session expired");
    /* An idle guest is deleted after a day (guest-cleanup.ts); a visit counts, marked at most every five minutes. */
    await pool.query("UPDATE users SET last_seen_at=now() WHERE id=$1 AND (last_seen_at IS NULL OR last_seen_at<now()-interval '5 minutes')", [result.rows[0].id]);
  }
  return result.rows[0];
}
export async function ensureLocalUser(pool: Pool): Promise<Principal> {
  return transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(78146722)");
    const existing = (await client.query("SELECT id,email FROM users ORDER BY created_at LIMIT 1")).rows[0];
    if (existing) {
      const membership = (await client.query("SELECT workspace_id FROM memberships WHERE user_id=$1 LIMIT 1", [existing.id])).rows[0];
      if (!membership) {
        const workspaceId = newId();
        await client.query("INSERT INTO workspaces(id,name) VALUES($1,'Local studio')", [workspaceId]);
        await client.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')", [workspaceId, existing.id]);
      }
      return existing as Principal;
    }
    const userId = newId(), workspaceId = newId();
    await client.query("INSERT INTO users(id,email,password_hash) VALUES($1,'local@comfyfield.local',$2)", [userId, await hashPassword(generateLocalSecret())]);
    await client.query("INSERT INTO workspaces(id,name) VALUES($1,'Local studio')", [workspaceId]);
    await client.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')", [workspaceId, userId]);
    return { id: userId, email: "local@comfyfield.local" };
  });
}
/** A hosted try-out gives every browser its own guest: its own workspace and project, so one visitor
 *  never sees another one's files, runs or Comfy Cloud account. The guest has no password to sign in with. */
export async function createGuest(pool: Pool): Promise<Principal> {
  return transaction(pool, async client => {
    const userId = newId(), workspaceId = newId(), email = `guest-${userId}${GUEST_DOMAIN}`;
    await client.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)", [userId, email, await hashPassword(generateLocalSecret())]);
    await client.query("INSERT INTO workspaces(id,name) VALUES($1,'My studio')", [workspaceId]);
    await client.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')", [workspaceId, userId]);
    await client.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'First project',$3)", [newId(), workspaceId, userId]);
    return { id: userId, email };
  });
}
function generateLocalSecret(): string { return newId() + newId() + newId(); }
export async function member(pool: Pool, request: FastifyRequest, workspaceId: string, minimum: Role = "viewer"): Promise<Principal & { role: Role }> {
  const user = await principal(pool, request);
  const result = await pool.query("SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2", [workspaceId, user.id]);
  const role = result.rows[0]?.role as Role | undefined;
  const rank = { viewer: 0, creator: 1, admin: 2 };
  if (!role || rank[role] < rank[minimum]) throw new HttpError(403, "Workspace permission required");
  return { ...user, role };
}
export async function bootstrap(pool: Pool, email: string, password: string, workspaceName: string): Promise<{ userId: string; workspaceId: string }> {
  const passwordHash = await hashPassword(password);
  return transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(78146721)");
    if ((await client.query("SELECT 1 FROM users LIMIT 1")).rowCount) throw new Error("Bootstrap is only available for an empty deployment");
    const userId = newId(), workspaceId = newId();
    await client.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)", [userId, email.toLowerCase().trim(), passwordHash]);
    await client.query("INSERT INTO workspaces(id,name) VALUES($1,$2)", [workspaceId, workspaceName]);
    await client.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')", [workspaceId,userId]);
    return { userId, workspaceId };
  });
}

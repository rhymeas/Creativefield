/* Who is behind the Comfy Cloud key: the name, email, workspace and credits Comfy's own user
   menu shows beside the signed-in account. Every read is a plain GET made with the key this
   server already holds for runs: the key travels in one header and is never stored, returned or
   logged, and nothing here submits a job or spends a credit.

   Comfy Cloud answers from two origins. The account itself (name, email, credits) is on the
   Comfy API — `GET /customers/me` and `GET /customers/balance`, the two calls the ComfyUI
   frontend makes with a stored API key (`X-API-KEY`). The workspace is on the cloud app a worker
   points at: `GET /api/workspaces/current`. The picture in Comfy's menu comes from a signed-in
   browser session, which a key does not have, so `avatarUrl` stays absent. */

import type {Pool} from "pg";
import {CLOUD_KEY_REASON,CLOUD_PLAN_BLOCKED_REASON} from "./cloud-readiness";
import {hashToken} from "./crypto";

/** A person's own Comfy Cloud account, as the app shows it beside the local one. */
export type CloudAccount = {
  /** The key on this server works: Comfy Cloud answered for it. */
  connected: boolean;
  name?: string;
  email?: string;
  /** Comfy's menu picture belongs to a browser session; a key has none, so this stays absent. */
  avatarUrl?: string;
  /** The Comfy workspace the key belongs to, such as "Personal Workspace". */
  workspace?: string;
  /** Credits, counted the way Comfy counts them: 211 to the dollar. */
  credits?: number;
  /** Whether this key's plan may submit a run; absent until a probe has asked. */
  canSubmit?: boolean;
  /** What a person reads when the plan will not submit, or when the key is not taken. */
  reason?: string;
  addCreditsUrl?: string;
};

/** Comfy credits are 211 to the dollar — `CREDITS_PER_USD` in the ComfyUI frontend's
 *  creditsUtil, which is also where the balance's `*_micros` fields are read as cents. */
const CREDITS_PER_USD = 211;
/** One read is reused this long, so the menu stays honest without asking on every look. */
const CACHE_MS = 60 * 1000;
const READ_TIMEOUT_MS = 8000;

/** What a person reads when Comfy Cloud will not take the key this server holds. */
export const CLOUD_KEY_REFUSED_REASON = "Comfy Cloud did not accept the key on this server.";

/** The account API. api.comfy.org is Comfy's own; a test points this at the fake cloud. */
function accountApi(): string {
  return (process.env.COMFY_CLOUD_ACCOUNT_API?.trim() || "https://api.comfy.org").replace(/\/+$/, "");
}

/** What the account reads said, before the worker's own inventory is added. */
type AccountFacts = {
  /** Comfy Cloud answered the key with 401 or 403. */
  refused: boolean;
  /** Nothing answered, so the account is unknown rather than refused. */
  unreachable: boolean;
  name?: string;
  email?: string;
  workspace?: string;
  credits?: number;
};

type Read = { status: number; body: Record<string, unknown> };

/** The reads already made, by account API, cloud app origin and a hash of the key. */
const factsCache = new Map<string, { at: number; facts: AccountFacts }>();

/** One GET with the key in a header. A refused connection or a body that is not JSON says
 *  nothing about the account, so it is reported as such instead of raising. */
async function getJson(base: string, path: string, key: string): Promise<Read> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      headers: {"X-API-KEY": key, Accept: "application/json"},
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    return {status: 0, body: {}};
  }
  const body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await response.text()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(body, parsed);
  } catch { /* A body that is not JSON carried no field to show. */ }
  return {status: response.status, body};
}

function sentence(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function amount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The balance in cents, then in credits. Comfy names its cent fields `*_micros`. */
function creditsFrom(balance: Record<string, unknown>): number | undefined {
  const cents = amount(balance.amount_cents) ?? amount(balance.amount_micros);
  return cents === undefined ? undefined : Math.round((cents * CREDITS_PER_USD) / 100);
}

/** Name, email, workspace and credits for one key, read at most once a minute. */
async function readFacts(cacheKey: string, origin: string, key: string): Promise<AccountFacts> {
  const cached = factsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.facts;
  const base = accountApi();
  const [me, balance, workspace] = await Promise.all([
    getJson(base, "/customers/me", key),
    getJson(base, "/customers/balance", key),
    getJson(origin, "/api/workspaces/current", key),
  ]);
  const facts: AccountFacts = {refused: me.status === 401 || me.status === 403, unreachable: me.status === 0};
  const name = sentence(me.body.name), email = sentence(me.body.email), workspaceName = sentence(workspace.body.name);
  const creditCount = creditsFrom(balance.body);
  if (name) facts.name = name;
  if (email) facts.email = email;
  if (workspaceName) facts.workspace = workspaceName;
  if (creditCount !== undefined) facts.credits = creditCount;
  /* A refused connection is a blip, not a fact about the account: it is not kept. */
  if (!facts.unreachable) {
    const now = Date.now();
    for (const [entry, kept] of factsCache) if (now - kept.at >= CACHE_MS) factsCache.delete(entry);
    factsCache.set(cacheKey, {at: now, facts});
  }
  return facts;
}

/**
 * The Comfy account behind the key this server submits runs with, for the workspace's enabled
 * Comfy Cloud worker. Read-only: three GETs at most, no job and no credits.
 */
export async function cloudAccountFor(pool: Pool, workspaceId: string, key?: string): Promise<CloudAccount> {
  const worker = (await pool.query("SELECT origin,inventory FROM workers WHERE workspace_id=$1 AND kind='cloud' AND enabled=true ORDER BY id LIMIT 1", [workspaceId])).rows[0];
  if (!worker) return {connected: false};
  if (!key) return {connected: false, reason: CLOUD_KEY_REASON};
  let origin: string;
  try { origin = new URL(worker.origin).origin; } catch { return {connected: false}; }
  const facts = await readFacts(`${accountApi()}\u0000${origin}\u0000${hashToken(key)}`, origin, key);
  if (facts.refused) return {connected: false, reason: CLOUD_KEY_REFUSED_REASON};
  if (facts.unreachable) return {connected: false, reason: "Comfy Cloud could not be asked about this key."};
  /* Whether the plan may submit a run is the probe's answer about the key, kept in the worker's
     inventory; it is not about the account read and costs no call here. */
  const inventory = (worker.inventory ?? {}) as {canSubmit?: boolean; submitBlockedReason?: string};
  const account: CloudAccount = {connected: true};
  if (facts.name) account.name = facts.name;
  if (facts.email) account.email = facts.email;
  if (facts.workspace) account.workspace = facts.workspace;
  if (facts.credits !== undefined) account.credits = facts.credits;
  if (inventory.canSubmit !== undefined) account.canSubmit = inventory.canSubmit;
  if (inventory.canSubmit === false) account.reason = inventory.submitBlockedReason ?? CLOUD_PLAN_BLOCKED_REASON;
  account.addCreditsUrl = `${origin}/?settings=plan-credits`;
  return account;
}

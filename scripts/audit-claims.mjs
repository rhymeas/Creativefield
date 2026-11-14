// The parity table quotes counts ("Ready 31", "Planned 17"). Those drift silently when a capability
// changes state, so this compares the document against the live catalogue and fails on a mismatch.
// Usage: npm run audit:claims (the app must be running).
import {readFileSync} from "node:fs";

const API = (process.env.COMFYFIELD_API ?? "http://127.0.0.1:8787/api/v1").replace(/\/$/, "");
const ORIGIN = new URL(API).origin;
const DOC = "docs/PARITY-STATUS.md";
const jar = new Map();

const healthy = await fetch(`${ORIGIN}/api/v1/health`).then(r => r.ok).catch(() => false);
if (!healthy) {
  console.log(`the app is not answering at ${ORIGIN} — start it with npm start, then run this again.`);
  process.exit(1);
}

async function call(method, path, body) {
  const headers = {origin: ORIGIN};
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(API + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair] = value.split(";");
    const index = pair.indexOf("=");
    jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}

await call("GET", "/auth/me");
const workspaces = await call("GET", "/workspaces");
const workspaceId = process.env.COMFYFIELD_WORKSPACE ?? workspaces[0]?.id;
if (!workspaceId) { console.log("no workspace found — start the app first."); process.exit(1); }

const workers = await call("GET", `/workspaces/${workspaceId}/workers`);
const worker = workers.find(w => w.enabled) ?? workers[0];
if (!worker) { console.log("no worker registered — add one in Settings, then run this again."); process.exit(1); }

/* Two endpoints, each answering half: /catalogue says which ids are capabilities, the probe says how
   each one stands on this worker. The probe also lists pipelines, so counting its rows directly
   overstates the total (59 against 53) — that was the first false alarm this script produced. */
const catalogue = await call("GET", `/workspaces/${workspaceId}/catalogue`);
const capabilityIds = new Set((Array.isArray(catalogue) ? catalogue : []).map(c => c.id));
const probed = await call("POST", `/workspaces/${workspaceId}/workers/${worker.id}/probe`);
const states = new Map((probed.capabilities ?? []).map(c => [c.id, c.readiness?.state ?? "unknown"]));
const count = {ready: 0, planned: 0, other: 0};
for (const id of capabilityIds) {
  const state = states.get(id) ?? "unknown";
  if (state === "ready") count.ready++;
  else if (state === "planned") count.planned++;
  else count.other++;
}

const doc = readFileSync(DOC, "utf8");
const claimedReady = Number(doc.match(/\|\s*\*\*Ready\*\*\s*\|\s*\*\*(\d+)\*\*/)?.[1] ?? NaN);
const claimedTotal = Number(doc.match(/\*\*(\d+) capability tiles\*\*/)?.[1] ?? NaN);

console.log(`worker: ${worker.name}`);
console.log(`live catalogue: ${capabilityIds.size} capabilities — ready ${count.ready}, not ready ${count.other}`);
const breakdown = {};
for (const id of capabilityIds) { const state = states.get(id) ?? "unknown"; breakdown[state] = (breakdown[state] ?? 0) + 1; }
console.log(`  by state: ${Object.entries(breakdown).map(([state, n]) => `${state} ${n}`).join(", ")}`);
console.log(`${DOC}: ${Number.isNaN(claimedTotal) ? "(total not found)" : claimedTotal} capabilities, ready ${Number.isNaN(claimedReady) ? "(not found)" : claimedReady}`);

/* Total and ready are the two numbers the API states directly. The document's "Planned" row is a
   product judgement, not a readiness state, so comparing it would invent a mismatch. */
const problems = [];
if (!Number.isNaN(claimedTotal) && capabilityIds.size !== claimedTotal) problems.push(`total says ${claimedTotal}, catalogue has ${capabilityIds.size}`);
if (!Number.isNaN(claimedReady) && count.ready !== claimedReady) problems.push(`ready says ${claimedReady}, catalogue has ${count.ready}`);
for (const problem of problems) console.log(`  MISMATCH ${problem}`);
process.exit(problems.length ? 1 : 0);

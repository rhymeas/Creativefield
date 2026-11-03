// Demo readiness check: worker online, demo outputs still in the library, and the
// order to record them. Read-only. Usage: node scripts/demo-prepare.mjs
import {existsSync, readdirSync, statSync} from "node:fs";
import path from "node:path";
const API = (process.env.COMFYFIELD_API ?? "http://127.0.0.1:8787/api/v1").replace(/\/$/, "");
const ORIGIN = new URL(API).origin;
const reelDir = process.env.COMFYFIELD_DEMO_DIR ? path.resolve(process.env.COMFYFIELD_DEMO_DIR) : "";
const WORKSPACE = process.env.COMFYFIELD_WORKSPACE;
const PROJECT = process.env.COMFYFIELD_PROJECT;
if (!WORKSPACE || !PROJECT || !reelDir) throw new Error("Set COMFYFIELD_WORKSPACE, COMFYFIELD_PROJECT and COMFYFIELD_DEMO_DIR.");
const jar = new Map();

async function call(method, path, body) {
  const headers = {origin: ORIGIN};
  if (jar.size) headers.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(API + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair] = value.split(";");
    const index = pair.indexOf("=");
    jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/* Reachability first: a readiness check that cannot reach the app must say so, not print an empty
   library and a runbook as though the state had been verified. */
const reachable = await fetch(`${ORIGIN}/api/v1/health`).then(response => response.ok).catch(() => false);
if (!reachable) {
  console.log(`the app is not answering at ${ORIGIN} — start it with npm start, then run this again.`);
  process.exit(1);
}
await call("GET", "/auth/me");
const workers = await call("GET", `/workspaces/${WORKSPACE}/workers`);
const enabled = workers.filter(worker => worker.enabled);
const online = enabled.filter(worker => worker.inventory?.online);
console.log(`Worker: ${enabled.length} enabled, ${online.length} online${online.length ? ` (${online.map(worker => worker.name).join(", ")})` : ""}`);
if (!online.length) console.log("  -> start ComfyUI and probe the worker before recording.");

const assets = (await call("GET", `/workspaces/${WORKSPACE}/assets?projectId=${PROJECT}&limit=200`)).items ?? [];
/* Durations come from this app's own run history, not from numbers typed into this script — a
   hard-coded median drifts the moment the machine or the models change. The runs endpoint returns
   the most recent 200, which is plenty for a median. */
const runs = (await call("GET", `/workspaces/${WORKSPACE}/runs`)) ?? [];
const durations = new Map();
for (const run of runs) {
  if (run.state !== "succeeded" || !run.created_at || !run.updated_at) continue;
  const seconds = (new Date(run.updated_at) - new Date(run.created_at)) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) continue;
  if (!durations.has(run.capability_id)) durations.set(run.capability_id, []);
  durations.get(run.capability_id).push(seconds);
}
const median = id => {
  const list = durations.get(id);
  if (!list?.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return {median: sorted[Math.floor(sorted.length / 2)], fast: sorted[0], slow: sorted.at(-1), n: sorted.length};
};
const clock = seconds => seconds === null ? null : seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s` : `${Math.round(seconds)}s`;
const timing = id => {
  const stat = median(id);
  return stat ? `median ${clock(stat.median)}, seen ${clock(stat.fast)}–${clock(stat.slow)} over ${stat.n} runs` : "no finished run recorded yet";
};
const wanted = [
  ["Change: New look", /vace-canny-restyle/],
  ["Change: Swap a thing", /masked-edit/],
  ["Change: Copy moves", /ui-copy-moves|ComfyUI_/],
  ["Change: Swap a face", /scail2-character-replace/],
  ["Storyboard film", /^storyboard-/],
  ["Create tab", /^ComfyUI_/],
  ["Marketing ad", /static-ad|marketing/],
];
console.log("\nLibrary outputs for the demo:");
for (const [label, pattern] of wanted) {
  const hits = assets.filter(asset => pattern.test(asset.name));
  console.log(`  ${hits.length ? "ok  " : "miss"} ${label}: ${hits.length} file(s)${hits[0] ? `, newest ${hits[0].name}` : ""}`);
}

console.log("\nRecord in this order (durations computed just now from the most recent 200 runs — recent takes are what you will hit):");
console.log(`  1. Change tab -> New look (${timing("vace-canny-restyle")})`);
console.log(`  2. Change tab -> Swap a thing (track ~20 s, edit ${timing("wan21-vace-masked-edit")})`);
console.log(`  3. Change tab -> Swap a face (turn the photo first, then ${timing("scail2-character-replace")})`);
console.log(`  4. Change tab -> Copy moves (${timing("wan-animate2-distilled")} — say the number)`);
console.log("  5. Make -> Cast/Scenes -> storyboard film (frames from the character, approve, animate)");
console.log("  6. Brand -> Marketing (product + brief -> 1080 PNG)");
console.log("  7. Setup: npm run doctor, licence and inventory docs");
console.log("\nBefore recording: use only generated characters, no unlicensed IP or music, 1440 or 2400 wide.");

/* A reel is offered as a cut-in; say whether one exists, how long it runs, and — the part that makes
   this a check rather than a decoration — whether it is older than the evidence it was built from. */
const reels = existsSync(reelDir) ? readdirSync(reelDir).filter(name => /demo-reel.*\.mp4$/i.test(name)) : [];
if (!reels.length) console.log("\nReel: none yet — build one with npm run demo:reel.");
else {
  const newest = reels.sort().at(-1);
  const reelFile = path.join(reelDir, newest);
  const size = Math.round(statSync(reelFile).size / 1e6);
  const evidenceDir = path.join(process.cwd(), ".comfyfield", "qa", "transform");
  const evidenceTime = existsSync(evidenceDir)
    ? Math.max(0, ...readdirSync(evidenceDir).map(name => { try { return statSync(path.join(evidenceDir, name)).mtimeMs; } catch { return 0; } }))
    : 0;
  const stale = evidenceTime > statSync(reelFile).mtimeMs + 1000;
  console.log(`\nReel: ${newest} (${size} MB). ${stale
    ? "Older than the newest evidence clip — run npm run demo:reel to rebuild it."
    : "Current against the evidence folder."}`);
}

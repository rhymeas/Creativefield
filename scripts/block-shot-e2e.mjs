// Opt-in end-to-end check of Block a shot through the ComfyField API: draws a grey-box layout and its depth
// pass from a set and a camera move, then renders the shot with the Wan VACE depth restyle on the local worker.
//
//   COMFYFIELD_E2E=1 node scripts/block-shot-e2e.mjs [set] [move] [seconds]
//
// Needs `npm start`, a running ComfyUI on a GPU with Wan 2.1 VACE, and ffmpeg. Output files are kept in

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.COMFYFIELD_URL ?? "http://127.0.0.1:8787", API = `${BASE}/api/v1`;

const [set = "street", move = "push-in", seconds = "2"] = process.argv.slice(2);
const PROMPT = process.env.BLOCK_SHOT_PROMPT ?? "A rainy European street at dusk, wet cobblestones, a woman in a red coat walking away from the camera, warm shop lights, cinematic";
const jar = new Map();

async function call(method, path, body) {
  const headers = { Origin: BASE };
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const value of response.headers.getSetCookie?.() ?? []) { const [pair] = value.split(";"), i = pair.indexOf("="); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const probe = (file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,nb_read_frames,codec_name", "-of", "json", file], { encoding: "utf8" })).streams[0];

async function main() {
  if (process.env.COMFYFIELD_E2E !== "1") { console.log("block-shot-e2e is opt-in: set COMFYFIELD_E2E=1 and start ComfyField + ComfyUI (GPU) first."); return; }
  mkdirSync(OUT, { recursive: true });
  await call("GET", "/auth/me");
  const [workspace] = await call("GET", "/workspaces"), base = `/workspaces/${workspace.id}`;
  const project = (await call("GET", `${base}/projects`))[0]?.id ?? (await call("POST", `${base}/projects`, { name: "Block a shot E2E" })).id;
  const worker = (await call("GET", `${base}/workers`)).find((w) => w.enabled && w.kind === "local");
  if (!worker) throw new Error("no enabled local worker");
  const started = Date.now();
  const shot = await call("POST", `${base}/block-shot`, { projectId: project, set, move, seconds: Number(seconds), aspect: "16:9" });
  console.log(`layout ${shot.layout.id} + depth ${shot.depth.id}: ${shot.frames} frames ${shot.width}x${shot.height} at ${shot.fps} fps, drawn in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const capability = (await call("GET", `${base}/catalogue`)).find((c) => c.id === "vace-depth-restyle");
  if (!capability) throw new Error("vace-depth-restyle is not in the catalogue");
  const run = await call("POST", `${base}/runs`, { projectId: project, workerId: worker.id, idempotencyKey: crypto.randomUUID(), capabilityId: capability.id, version: capability.version, routeId: "local", inputs: { source_video: shot.layout.id, depth_video: shot.depth.id }, controls: { prompt: PROMPT, negative: "blurry, distorted, unstable, text, watermark", seed: 20261030, strength: 1 }, audioPolicy: "mute" });
  process.stdout.write(`run ${run.id} `);
  const deadline = Date.now() + 40 * 60 * 1000;
  let done;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    done = await call("GET", `${base}/runs/${run.id}`);
    if (["succeeded", "failed", "cancelled", "submission_unknown"].includes(done.state)) break;
    process.stdout.write(".");
  }
  if (done?.state !== "succeeded") throw new Error(`run ${done?.state}: ${done?.error ?? "no error"}`);
  const output = done.output_ids?.[0];
  const files = {};
  for (const [key, id] of [["layout", shot.layout.id], ["depth", shot.depth.id], ["result", output]]) {
    const response = await fetch(`${API}${base}/assets/${id}/content`, { headers: { Origin: BASE, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    if (!response.ok) throw new Error(`download ${key}: HTTP ${response.status}`);
    files[key] = join(OUT, `${set}-${move}-${key}.mp4`);
    writeFileSync(files[key], Buffer.from(await response.arrayBuffer()));
  }
  const facts = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, probe(f)]));
  const r = facts.result, l = facts.layout;
  if (r.width !== l.width || r.height !== l.height || Number(r.nb_read_frames) !== Number(l.nb_read_frames)) throw new Error(`result ${r.width}x${r.height} ${r.nb_read_frames} frames does not match layout ${l.width}x${l.height} ${l.nb_read_frames} frames`);
  const seconds2 = Math.round((Date.now() - started) / 1000);
  console.log(`\nresult ${r.width}x${r.height}, ${r.nb_read_frames} frames, ${r.codec_name}; whole job ${seconds2} s; workflow ${(await call("GET", `${base}/runs/${run.id}/provenance`)).workflowHash.slice(0, 12)}`);
  writeFileSync(join(OUT, `${set}-${move}-receipt.json`), JSON.stringify({ at: new Date().toISOString(), set, move, seconds: Number(seconds), prompt: PROMPT, run: run.id, files, facts, jobSeconds: seconds2 }, null, 2) + "\n");
  console.log(`block-shot-e2e OK; files in ${OUT}`);
}
main().catch((e) => { console.error(`\nblock-shot-e2e FAILED: ${e.message}`); process.exit(1); });

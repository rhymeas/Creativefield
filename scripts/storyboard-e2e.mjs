// Opt-in real storyboard render through the ComfyField API and local ComfyUI.
// Creates a board with two one-second T2V shots, renders it, then verifies the
// assembled file with ffprobe. Requires `npm start`, ComfyUI and ffmpeg.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.COMFYFIELD_URL ?? "http://127.0.0.1:8787";
const API = `${BASE}/api/v1`;
const origin = { Origin: BASE };
const jar = new Map();

const cookies = () => [...jar].map(([key, value]) => `${key}=${value}`).join("; ");

async function call(method, path, body) {
  const headers = { ...origin, cookie: cookies() };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(API + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair] = value.split(";");
    const index = pair.indexOf("=");
    jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function wait(base, id, limitMs) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const render = await call("GET", `${base}/storyboard-renders/${id}`);
    process.stdout.write(".");
    if (["succeeded", "failed", "cancelled"].includes(render.state)) return render;
  }
  throw new Error(`render ${id} did not finish within ${limitMs / 1000}s`);
}

async function main() {
  if (process.env.COMFYFIELD_E2E !== "1") {
    console.log("e2e:storyboard is opt-in: set COMFYFIELD_E2E=1 and start ComfyField + ComfyUI first.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "comfyfield-storyboard-"));
  try {
    await call("GET", "/auth/me");
    const [workspace] = await call("GET", "/workspaces");
    const base = `/workspaces/${workspace.id}`;
    const projects = await call("GET", `${base}/projects`);
    const project = projects[0]?.id ?? (await call("POST", `${base}/projects`, { name: "Storyboard E2E" })).id;
    const worker = (await call("GET", `${base}/workers`)).find(item => item.enabled);
    if (!worker) throw new Error("no enabled worker");
    const capability = (await call("GET", `${base}/catalogue`)).find(entry => entry.id === "wan22-ti2v-5b-t2v");
    if (!capability) throw new Error("wan22-ti2v-5b-t2v is not in the catalogue");

    const generation = (_prompt, seed) => ({
      capabilityId: capability.id, version: capability.version, routeId: "local",
      controls: { seed },
    });
    const board = await call("POST", `${base}/storyboards`, { name: "Real storyboard E2E", projectId: project });
    const shots = [
      { prompt: "A red cabin beside a frozen lake at dawn", durationSeconds: 1, settings: { generation: generation("A red cabin beside a frozen lake at dawn", 20261019) } },
      { prompt: "The same lake under a blue evening sky", durationSeconds: 1, settings: { generation: generation("The same lake under a blue evening sky", 20261020) } },
    ];
    const saved = await call("PUT", `${base}/storyboards/${board.id}/shots`, { revision: 1, shots });
    if (saved.revision !== 2) console.log(`note saved revision ${saved.revision}`);
    const started = Date.now();
    const render = await call("POST", `${base}/storyboards/${board.id}/renders`, {
      revision: 2, workerId: worker.id, idempotencyKey: crypto.randomUUID(),
      assembly: { width: 640, height: 360, fps: 24, audioPolicy: "mute" },
    });
    console.log(`board ${board.id} render ${render.id}`);
    const done = await wait(base, render.id, 25 * 60 * 1000);
    if (done.state !== "succeeded") throw new Error(`storyboard ${done.state}: ${done.error ?? "no error"}`);
    if (!done.output_asset_id) throw new Error("storyboard has no output asset");
    if (done.shots?.length !== 2) throw new Error(`expected 2 shots, got ${done.shots?.length}`);

    const asset = await call("GET", `${base}/assets/${done.output_asset_id}`);
    const file = join(root, "storyboard.mp4");
    const response = await fetch(`${API}${base}/assets/${done.output_asset_id}/content`, { headers: { ...origin, cookie: cookies() } });
    if (!response.ok) throw new Error(`download HTTP ${response.status}`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    const raw = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames",
      "-show_entries", "stream=width,height,r_frame_rate,nb_read_frames,duration", "-of", "json", file], { encoding: "utf8" });
    const facts = JSON.parse(raw).streams[0];
    const result = {
      width: facts.width, height: facts.height, fps: facts.r_frame_rate,
      frames: Number(facts.nb_read_frames), seconds: Number(facts.duration),
    };
    if (result.width !== 640 || result.height !== 360 || result.fps !== "24/1" || result.frames !== 48) {
      throw new Error(`unexpected assembly ${JSON.stringify(result)}`);
    }
    console.log(`storyboard OK ${result.width}x${result.height} ${result.frames}f ${result.fps} ${result.seconds}s in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`asset ${asset.name} ${(asset.bytes / 1024).toFixed(0)} KiB`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(`e2e:storyboard FAILED: ${error.message}`); process.exit(1); });

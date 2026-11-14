// Opt-in end-to-end check of the FILM frame interpolation pack through the
// ComfyField API. Requires `npm start`, a running ComfyUI and ffmpeg/ffprobe.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.COMFYFIELD_URL ?? "http://127.0.0.1:8787";
const API = `${BASE}/api/v1`;
const origin = { Origin: BASE };
const jar = new Map();

function cookieHeader() {
  return [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
}

async function call(method, path, body, form) {
  const headers = { ...origin };
  if (jar.size) headers.cookie = cookieHeader();
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(API + path, {
    method,
    headers,
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
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

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: "pipe" });
}

function probe(file) {
  const raw = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=width,height,r_frame_rate,nb_read_frames,duration", "-of", "json", file], { encoding: "utf8" });
  const stream = JSON.parse(raw).streams[0];
  return {
    width: stream.width, height: stream.height, fps: stream.r_frame_rate,
    frames: Number(stream.nb_read_frames), seconds: Number(stream.duration),
  };
}

async function waitFor(base, id, limitMs) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const run = await call("GET", `${base}/runs/${id}`);
    if (["succeeded", "failed", "cancelled", "submission_unknown"].includes(run.state)) return run;
    process.stdout.write(".");
  }
  throw new Error(`run ${id} did not finish within ${limitMs / 1000}s`);
}

async function main() {
  if (process.env.COMFYFIELD_E2E !== "1") {
    console.log("e2e:interpolate is opt-in: set COMFYFIELD_E2E=1 and start ComfyField + ComfyUI first.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "comfyfield-interpolate-"));
  let project;
  try {
    await call("GET", "/auth/me");
    const [workspace] = await call("GET", "/workspaces");
    const base = `/workspaces/${workspace.id}`;
    const projects = await call("GET", `${base}/projects`);
    project = projects[0]?.id ?? (await call("POST", `${base}/projects`, { name: "Frame interpolation E2E" })).id;
    const worker = (await call("GET", `${base}/workers`)).find(item => item.enabled);
    if (!worker) throw new Error("no enabled worker");
    const catalogue = await call("GET", `${base}/catalogue`);
    const capability = catalogue.find(entry => entry.id === "film-frame-interpolation");
    if (!capability) throw new Error("film-frame-interpolation is not in the catalogue");
    console.log(`worker ${worker.name ?? worker.id}, project ${project}`);

    const source = join(root, "source.mp4");
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=16:d=1.0625", "-frames:v", "17", "-c:v", "libx264", "-pix_fmt", "yuv420p", source]);
    const form = new FormData();
    form.append("file", new Blob([readFileSync(source)], { type: "video/mp4" }), "source.mp4");
    const asset = await call("POST", `${base}/assets?projectId=${project}&kind=video`, undefined, form);

    const started = Date.now();
    const run = await call("POST", `${base}/runs`, {
      projectId: project, workerId: worker.id, idempotencyKey: crypto.randomUUID(),
      capabilityId: capability.id, version: capability.version, routeId: "local",
      inputs: { source_video: asset.id },
      controls: { multiplier: 2, output_fps: 32 },
      audioPolicy: "mute",
    });
    console.log(`\ninterpolation run ${run.id}`);
    const done = await waitFor(base, run.id, 10 * 60 * 1000);
    if (done.state !== "succeeded") throw new Error(`interpolation ${done.state}: ${done.error ?? "no error"}`);
    const provenance = await call("GET", `${base}/runs/${run.id}/provenance`);
    if (provenance.execution !== "local_comfy" || !provenance.workflowHash) throw new Error("interpolation provenance incomplete");
    const output = done.output_ids?.[0];
    if (!output) throw new Error("interpolation has no output");
    const outputAsset = await call("GET", `${base}/assets/${output}`);
    const file = join(root, "interpolated.mp4");
    const response = await fetch(`${API}${base}/assets/${output}/content`, { headers: { ...origin, cookie: cookieHeader() } });
    if (!response.ok) throw new Error(`interpolation download HTTP ${response.status}`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    const facts = probe(file);
    if (facts.width !== 320 || facts.height !== 180 || facts.frames !== 33 || facts.fps !== "32/1") {
      throw new Error(`interpolation unexpected output ${JSON.stringify(facts)}`);
    }
    if (outputAsset.metadata?.width !== 320 || outputAsset.metadata?.height !== 180 || outputAsset.metadata?.frameRate !== "32/1" || outputAsset.metadata?.hasAudio !== false) {
      throw new Error(`interpolation asset metadata ${JSON.stringify(outputAsset.metadata)}`);
    }
    console.log(`interpolate OK ${facts.width}x${facts.height} ${facts.frames}f ${facts.fps} workflow ${provenance.workflowHash.slice(0, 12)} asset ${outputAsset.name} in ${(Date.now() - started) / 1000}s`);
    console.log("\ne2e:interpolate OK FILM through ComfyField");
  } finally {
    if (project && process.env.COMFYFIELD_E2E_KEEP !== "1") {
      rmSync(root, { recursive: true, force: true });
    } else {
      console.log(`kept ${root}`);
    }
  }
}

main().catch(error => { console.error(`e2e:interpolate FAILED: ${error.message}`); process.exit(1); });

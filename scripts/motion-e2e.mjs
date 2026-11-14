// Opt-in motion-control E2E through the real ComfyField API and ComfyUI.
// Uploads a start image and a strict 24 FPS driving video, queues the
// Wan Animate run, then verifies provenance, asset metadata and the file.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.COMFYFIELD_URL ?? "http://127.0.0.1:8787";
const API = `${BASE}/api/v1`;
const origin = { Origin: BASE };
const jar = new Map();

async function call(method, path, body, form) {
  const headers = { ...origin };
  if (jar.size) headers.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(API + path, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair] = value.split(";");
    jar.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function ffmpeg(args) { execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: "pipe" }); }
function probe(file) {
  const raw = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=width,height,r_frame_rate,nb_read_frames,duration", "-of", "json", file], { encoding: "utf8" });
  const stream = JSON.parse(raw).streams[0];
  return { width: stream.width, height: stream.height, fps: stream.r_frame_rate, frames: Number(stream.nb_read_frames), seconds: Number(stream.duration) };
}

async function upload(base, project, file, kind, type) {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(file)], { type }), file.split(/[\\/]/).pop());
  return (await call("POST", `${base}/assets?projectId=${project}&kind=${kind}`, undefined, form)).id;
}

async function main() {
  if (process.env.COMFYFIELD_E2E !== "1") {
    console.log("e2e:motion is opt-in: set COMFYFIELD_E2E=1 and start ComfyField + ComfyUI first.");
    return;
  }
  await call("GET", "/auth/me");
  const [workspace] = await call("GET", "/workspaces");
  const base = `/workspaces/${workspace.id}`;
  const project = (await call("GET", `${base}/projects`))[0]?.id;
  if (!project) throw new Error("no project");
  const worker = (await call("GET", `${base}/workers`)).find(item => item.enabled);
  if (!worker) throw new Error("no enabled worker");
  const capability = (await call("GET", `${base}/catalogue`)).find(item => item.id === "wan-animate2-distilled");
  if (!capability) throw new Error("motion capability missing");

  const root = mkdtempSync(join(tmpdir(), "comfyfield-motion-"));
  try {
    const image = join(root, "start.png");
    const video = join(root, "driving.mp4");
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=482x854", "-frames:v", "1", image]);
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=320x400:r=24:d=3.375", "-frames:v", "81", "-pix_fmt", "yuv420p", "-c:v", "libx264", video]);
    const startImage = await upload(base, project, image, "image", "image/png");
    const motionVideo = await upload(base, project, video, "video", "video/mp4");

    const run = await call("POST", `${base}/runs`, {
      projectId: project, workerId: worker.id, idempotencyKey: crypto.randomUUID(),
      capabilityId: capability.id, version: capability.version, routeId: "local",
      inputs: { start_image: startImage, motion_video: motionVideo },
      controls: { prompt: "A person walking through a bright studio, cinematic", motion_prompt: "Walk toward the camera", negative: "blurry, distorted", width: 482, height: 854, seed: 20261019 },
      audioPolicy: "mute",
    });
    console.log(`motion run ${run.id} (${capability.version})`);
    const deadline = Date.now() + 30 * 60 * 1000;
    let done = run;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      done = await call("GET", `${base}/runs/${run.id}`);
      if (["succeeded", "failed", "cancelled", "submission_unknown"].includes(done.state)) break;
      process.stdout.write(".");
    }
    if (done.state !== "succeeded") throw new Error(`motion ${done.state}: ${done.error ?? "no error"}`);

    const provenance = await call("GET", `${base}/runs/${run.id}/provenance`);
    if (provenance.execution !== "local_comfy" || !provenance.workflowHash) throw new Error("provenance incomplete");
    const output = done.output_ids?.[0];
    if (!output) throw new Error("no output");
    const asset = await call("GET", `${base}/assets/${output}`);
    const response = await fetch(`${API}${base}/assets/${output}/content`, { headers: { ...origin, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    if (!response.ok) throw new Error(`download HTTP ${response.status}`);
    const file = join(root, "motion.mp4");
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    const facts = probe(file);
    if (facts.width !== 480 || facts.height !== 848 || facts.frames !== 81 || facts.fps !== "24/1") {
      throw new Error(`unexpected motion output ${JSON.stringify(facts)}`);
    }
    console.log(`e2e:motion OK ${facts.width}x${facts.height} ${facts.frames}f ${facts.fps} ${facts.seconds}s asset ${asset.name} workflow ${provenance.workflowHash.slice(0, 12)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(`e2e:motion FAILED: ${error.message}`); process.exit(1); });

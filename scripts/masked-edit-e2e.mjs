// Opt-in end-to-end check of the real masked-edit pipeline through the
// ComfyField API. Requires `npm start`, a running ComfyUI and ffmpeg/ffprobe.
// It creates an ordinary 30 FPS source/mask pair, uploads it through the
// mask-sequence flow (server normalizes it to the aligned 16 FPS envelope),
// waits for the run, then verifies provenance, asset metadata and file.

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
    console.log("e2e:masked is opt-in: set COMFYFIELD_E2E=1 and start ComfyField + ComfyUI first.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "comfyfield-masked-e2e-"));
  try {
    await call("GET", "/auth/me");
    const [workspace] = await call("GET", "/workspaces");
    const base = `/workspaces/${workspace.id}`;
    const projects = await call("GET", `${base}/projects`);
    const project = projects[0]?.id ?? (await call("POST", `${base}/projects`, { name: "Masked edit E2E" })).id;
    const worker = (await call("GET", `${base}/workers`)).find(item => item.enabled);
    if (!worker) throw new Error("no enabled worker");
    const catalogue = await call("GET", `${base}/catalogue`);
    const capability = catalogue.find(entry => entry.id === "wan21-vace-masked-edit");
    if (!capability) throw new Error("wan21-vace-masked-edit is not in the catalogue");
    console.log(`worker ${worker.name ?? worker.id}, project ${project}`);

    const sourceFile = join(root, "source.mp4");
    const maskFile = join(root, "mask.mp4");
    ffmpeg(["-f", "lavfi", "-i", "color=c=gray:s=160x96:r=30:d=1", "-frames:v", "30",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "0", sourceFile]);
    ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=160x96:r=30:d=1",
      "-vf", "drawbox=x=32:y=16:w=64:h=64:color=white:t=fill", "-frames:v", "30",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "0", maskFile]);

    const sourceForm = new FormData();
    sourceForm.append("file", new Blob([readFileSync(sourceFile)], { type: "video/mp4" }), "source.mp4");
    const source = await call("POST", `${base}/assets?projectId=${project}&kind=video`, undefined, sourceForm);
    const maskForm = new FormData();
    maskForm.append("file", new Blob([readFileSync(maskFile)], { type: "video/mp4" }), "mask.mp4");
    const mask = await call("POST", `${base}/assets/${source.id}/mask-sequence`, undefined, maskForm);
    const normalization = mask.metadata?.maskNormalization;
    if (!normalization || normalization.originalSourceAssetId !== source.id || normalization.frames !== 17 || normalization.fps !== 16) {
      throw new Error("upload did not normalize ordinary footage to the aligned 16 FPS envelope");
    }
    console.log(`source ${source.name}, normalized mask ${mask.name} -> 160x96 ${normalization.frames}f 16fps`);

    const run = await call("POST", `${base}/runs`, {
      projectId: project, workerId: worker.id, idempotencyKey: crypto.randomUUID(),
      capabilityId: capability.id, version: capability.version, routeId: "local",
      inputs: { source_video: source.id, edit_mask: mask.id },
      controls: { prompt: "A blue vase on a wooden table, cinematic", negative: "blurry, low quality", seed: 20261019, strength: 1 },
      audioPolicy: "mute",
    });
    console.log(`masked edit run ${run.id}`);
    const done = await waitFor(base, run.id, 20 * 60 * 1000);
    if (done.state !== "succeeded") throw new Error(`masked edit ${done.state}: ${done.error ?? "no error"}`);
    const provenance = await call("GET", `${base}/runs/${run.id}/provenance`);
    if (provenance.execution !== "local_comfy" || !provenance.workflowHash) throw new Error("provenance incomplete");
    if (provenance.invocation?.maskNormalization?.originalSourceAssetId !== source.id || provenance.invocation?.mediaSnapshot?.frames !== 17) {
      throw new Error("provenance does not pin the normalized masked-edit envelope");
    }
    const output = done.output_ids?.[0];
    if (!output) throw new Error("masked edit has no output");
    const asset = await call("GET", `${base}/assets/${output}`);
    const file = join(root, "output.mp4");
    const response = await fetch(`${API}${base}/assets/${output}/content`, { headers: { ...origin, cookie: cookieHeader() } });
    if (!response.ok) throw new Error(`download HTTP ${response.status}`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    const facts = probe(file);
    if (facts.width !== 160 || facts.height !== 96 || facts.frames !== 17 || facts.fps !== "16/1") {
      throw new Error(`unexpected output ${JSON.stringify(facts)}`);
    }
    console.log(`masked edit OK ${facts.width}x${facts.height} ${facts.frames}f ${facts.fps} workflow ${provenance.workflowHash.slice(0, 12)} asset ${asset.name}`);
    console.log("\ne2e:masked OK through ComfyField");
  } finally {
    if (process.env.COMFYFIELD_E2E_KEEP !== "1") rmSync(root, { recursive: true, force: true });
    else console.log(`kept ${root}`);
  }
}

main().catch(error => { console.error(`e2e:masked FAILED: ${error.message}`); process.exit(1); });

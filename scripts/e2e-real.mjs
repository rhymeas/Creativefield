// Opt-in end-to-end check of the real local ComfyUI pipelines through the
// ComfyField API. Requires `npm start`, a running ComfyUI and ffmpeg/ffprobe.
// It creates a project, uploads generated inputs, waits for each run, then
// verifies provenance, asset metadata and the downloaded file.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureMotion, motionVerdict } from "./motion-check-lib.mjs";

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
    console.log("e2e:real is opt-in: set COMFYFIELD_E2E=1 and start ComfyField + ComfyUI first.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "comfyfield-e2e-"));
  let project;
  try {
    await call("GET", "/auth/me");
    const [workspace] = await call("GET", "/workspaces");
    const base = `/workspaces/${workspace.id}`;
    const projects = await call("GET", `${base}/projects`);
    project = projects[0]?.id ?? (await call("POST", `${base}/projects`, { name: "Real pipeline E2E" })).id;
    const wanted = process.env.COMFYFIELD_WORKER;
    const all = (await call("GET", `${base}/workers`)).filter(item => item.enabled);
    const worker = (wanted && all.find(item => (item.name ?? item.id).toLowerCase().includes(wanted.toLowerCase()))) || all.find(item => !/cloud/i.test(item.name ?? "")) || all[0];
    if (!worker) throw new Error("no enabled worker");
    const catalogue = await call("GET", `${base}/catalogue`);
    console.log(`worker ${worker.name ?? worker.id}, project ${project}`);

    async function upload(name, source) {
      const file = join(root, name);
      ffmpeg(["-f", "lavfi", "-i", source, "-frames:v", "1", file]);
      const form = new FormData();
      form.append("file", new Blob([readFileSync(file)], { type: "image/png" }), name);
      const asset = await call("POST", `${base}/assets?projectId=${project}&kind=image`, undefined, form);
      return asset.id;
    }

    const start = await upload("start.png", "testsrc2=s=832x480");
    const end = await upload("end.png", "color=c=0x2244aa:s=832x480");
    const cases = [
      {
        id: "wan22-ti2v-5b-t2v", label: "T2V", inputs: {},
        controls: { prompt: "A small red cabin beside a frozen lake at dawn, cinematic", negative: "blurry, low quality", width: 1280, height: 704, length: 1, seed: 20261019 },
        expect: { width: 1280, height: 704, frames: 25, fps: "24/1" },
      },
      {
        id: "wan22-i2v-14b", label: "I2V", inputs: { start_image: start },
        controls: { prompt: "The colorful test pattern moves gently, cinematic", negative: "blurry, low quality", width: 832, height: 480, length: 1, seed: 20261019 },
        expect: { width: 832, height: 480, frames: 17, fps: "16/1" },
      },
      {
        id: "wan22-flf2v-14b", label: "FLF", inputs: { start_image: start, end_image: end },
        controls: { prompt: "The colorful pattern dissolves into a calm blue field, smooth motion", negative: "blurry, low quality", width: 832, height: 480, length: 1, seed: 20261019 },
        expect: { width: 832, height: 480, frames: 17, fps: "16/1" },
      },
    ];

    for (const item of cases) {
      const capability = catalogue.find(entry => entry.id === item.id);
      if (!capability) throw new Error(`${item.id} is not in the catalogue`);
      const started = Date.now();
      const run = await call("POST", `${base}/runs`, {
        projectId: project, workerId: worker.id, idempotencyKey: crypto.randomUUID(),
        capabilityId: capability.id, version: capability.version, routeId: "local",
        inputs: item.inputs, controls: item.controls, audioPolicy: "mute",
      });
      console.log(`\n${item.label} run ${run.id}`);
      const done = await waitFor(base, run.id, 20 * 60 * 1000);
      if (done.state !== "succeeded") throw new Error(`${item.label} ${done.state}: ${done.error ?? "no error"}`);
      const provenance = await call("GET", `${base}/runs/${run.id}/provenance`);
      if (provenance.execution !== "local_comfy" || !provenance.workflowHash) throw new Error(`${item.label} provenance incomplete`);
      const output = done.output_ids?.[0];
      if (!output) throw new Error(`${item.label} has no output`);
      const asset = await call("GET", `${base}/assets/${output}`);
      const file = join(root, `${item.label}.mp4`);
      const response = await fetch(`${API}${base}/assets/${output}/content`, { headers: { ...origin, cookie: cookieHeader() } });
      if (!response.ok) throw new Error(`${item.label} download HTTP ${response.status}`);
      writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      const facts = probe(file);
      const expected = item.expect;
      if (facts.width !== expected.width || facts.height !== expected.height || facts.frames !== expected.frames || facts.fps !== expected.fps) {
        throw new Error(`${item.label} unexpected output ${JSON.stringify(facts)}`);
      }
      // Motion: a clip that is static, or only a fade, is not a working video entry. Printed for every clip;
      // COMFYFIELD_E2E_MOTION=strict makes a static clip fail the run (these clips are 1 s, so the default only reports).
      const motion = motionVerdict(measureMotion(file));
      console.log(`${item.label} motion ${motion.level}: ${motion.reason}`);
      if (motion.level === "static" && process.env.COMFYFIELD_E2E_MOTION === "strict") throw new Error(`${item.label} is static`);
      if (asset.metadata?.frameRate !== expected.fps && asset.metadata?.frameRate !== expected.fps.replace("/", "/")) {
        console.log(`note ${item.label} asset frameRate ${asset.metadata?.frameRate}`);
      }
      console.log(`${item.label} OK ${facts.width}x${facts.height} ${facts.frames}f ${facts.fps} ${(Date.now() - started) / 1000}s workflow ${provenance.workflowHash.slice(0, 12)} asset ${asset.name}`);
    }
    console.log("\ne2e:real OK T2V, I2V and FLF through ComfyField");
  } finally {
    if (project && process.env.COMFYFIELD_E2E_KEEP !== "1") {
      rmSync(root, { recursive: true, force: true });
    } else {
      console.log(`kept ${root}`);
    }
  }
}

main().catch(error => { console.error(`e2e:real FAILED: ${error.message}`); process.exit(1); });

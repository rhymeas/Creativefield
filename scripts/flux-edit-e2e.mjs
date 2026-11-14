// Opt-in end-to-end check of the Flux 2 Klein image edit pack through the
// ComfyField API. Requires `npm start`, a running ComfyUI and ffmpeg.

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
    method, headers,
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

function pngSize(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") throw new Error("output is not a PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function waitFor(base, id, limitMs) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const run = await call("GET", `${base}/runs/${id}`);
    if (["succeeded", "failed", "cancelled", "submission_unknown"].includes(run.state)) return run;
    process.stdout.write(".");
  }
  throw new Error(`run ${id} did not finish within ${limitMs / 1000}s`);
}

async function main() {
  if (process.env.COMFYFIELD_E2E !== "1") {
    console.log("e2e:flux-edit is opt-in: set COMFYFIELD_E2E=1 and start ComfyField + ComfyUI first.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "comfyfield-flux-edit-"));
  let project;
  try {
    await call("GET", "/auth/me");
    const [workspace] = await call("GET", "/workspaces");
    const base = `/workspaces/${workspace.id}`;
    const projects = await call("GET", `${base}/projects`);
    project = projects[0]?.id ?? (await call("POST", `${base}/projects`, { name: "Flux image edit E2E" })).id;
    const worker = (await call("GET", `${base}/workers`)).find(item => item.enabled);
    if (!worker) throw new Error("no enabled worker");
    const catalogue = await call("GET", `${base}/catalogue`);
    const capability = catalogue.find(entry => entry.id === "flux2-klein-edit");
    if (!capability) throw new Error("flux2-klein-edit is not in the catalogue");
    console.log(`worker ${worker.name ?? worker.id}, project ${project}`);

    const source = join(root, "source.png");
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=1024x1024", "-frames:v", "1", source]);
    const form = new FormData();
    form.append("file", new Blob([readFileSync(source)], { type: "image/png" }), "source.png");
    const asset = await call("POST", `${base}/assets?projectId=${project}&kind=image`, undefined, form);

    const started = Date.now();
    const run = await call("POST", `${base}/runs`, {
      projectId: project, workerId: worker.id, idempotencyKey: crypto.randomUUID(),
      capabilityId: capability.id, version: capability.version, routeId: "local",
      inputs: { source_image: asset.id },
      controls: { prompt: "Change the background to a snowy mountain at dusk, keep the foreground unchanged", steps: 4, megapixels: 1, seed: 20261019 },
      audioPolicy: "mute",
    });
    console.log(`\nflux edit run ${run.id}`);
    const done = await waitFor(base, run.id, 10 * 60 * 1000);
    if (done.state !== "succeeded") throw new Error(`flux edit ${done.state}: ${done.error ?? "no error"}`);
    const provenance = await call("GET", `${base}/runs/${run.id}/provenance`);
    if (provenance.execution !== "local_comfy" || !provenance.workflowHash) throw new Error("flux edit provenance incomplete");
    const output = done.output_ids?.[0];
    if (!output) throw new Error("flux edit has no output");
    const outputAsset = await call("GET", `${base}/assets/${output}`);
    const file = join(root, "edited.png");
    const response = await fetch(`${API}${base}/assets/${output}/content`, { headers: { ...origin, cookie: cookieHeader() } });
    if (!response.ok) throw new Error(`flux edit download HTTP ${response.status}`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    const size = pngSize(file);
    if (size.width !== 1024 || size.height !== 1024) throw new Error(`flux edit unexpected PNG ${size.width}x${size.height}`);
    console.log(`flux edit OK ${size.width}x${size.height} workflow ${provenance.workflowHash.slice(0, 12)} asset ${outputAsset.name} in ${(Date.now() - started) / 1000}s`);
    console.log("\ne2e:flux-edit OK Flux 2 Klein image edit through ComfyField");
  } finally {
    if (project && process.env.COMFYFIELD_E2E_KEEP !== "1") {
      rmSync(root, { recursive: true, force: true });
    } else {
      console.log(`kept ${root}`);
    }
  }
}

main().catch(error => { console.error(`e2e:flux-edit FAILED: ${error.message}`); process.exit(1); });

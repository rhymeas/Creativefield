// Opt-in end-to-end check of the imported utility packs (bg-remove-birefnet, upscale-image-esrgan,
// palette-transfer-image, image-face-mosaic-sam3, scene-mesh-moge, video-trim, video-concat-2, kenburns-still,
// video-bg-remove-birefnet) through the ComfyField API.
// Requires `npm start`, a running ComfyUI with the packs' models, and ffmpeg.
//
//   COMFYFIELD_E2E=1 node scripts/utility-packs-e2e.mjs [pack-id ...]
//
// Each pack runs once on a real Pexels fixture (fixtures/real). The output files are kept in


import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.COMFYFIELD_URL ?? "http://127.0.0.1:8787";
const API = `${BASE}/api/v1`;

const FIXTURES = new URL("../fixtures/real/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const jar = new Map();

const cookieHeader = () => [...jar].map(([key, value]) => `${key}=${value}`).join("; ");

async function call(method, path, body, form) {
  const headers = { Origin: BASE };
  if (jar.size) headers.cookie = cookieHeader();
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(API + path, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair] = value.split(";");
    const index = pair.indexOf("=");
    jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const ffprobe = (file, entries) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_entries", entries, file], { encoding: "utf8" }));
const probeVideo = (file) => { const j = ffprobe(file, "stream=codec_type,codec_name,pix_fmt,width,height,nb_frames,r_frame_rate:format=duration"); const v = j.streams.find((s) => s.codec_type === "video"); const [n, d] = (v.r_frame_rate ?? "0/1").split("/").map(Number); return { width: v.width, height: v.height, pixFmt: v.pix_fmt, codec: v.codec_name, fps: n / d, seconds: Number(j.format.duration), hasAudio: j.streams.some((s) => s.codec_type === "audio") }; };
const ffmpeg = (args) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: "pipe" });
/** Raw RGBA bytes of any image, at its own size. */
const rgba = (file, width, height) => execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: width * height * 4 + 1024 });

function pngSize(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") throw new Error(`${file} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
}

async function waitFor(base, id, limitMs) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const run = await call("GET", `${base}/runs/${id}`);
    if (["succeeded", "failed", "cancelled", "submission_unknown"].includes(run.state)) return run;
    process.stdout.write(".");
  }
  throw new Error(`run ${id} did not finish within ${limitMs / 1000}s`);
}

/** Each case: the fixture it starts from, how it is prepared, the controls, and what the result must show. */
const CASES = {
  "bg-remove-birefnet": {
    inputs: { source_image: () => prepare("product-mug-white.jpg", "mug.png", 768) }, controls: {},
    check(files, ctx) {
      const out = pngSize(files.image);
      if (out.colorType !== 6) throw new Error(`cut-out is not RGBA (PNG color type ${out.colorType})`);
      const px = rgba(files.image, out.width, out.height);
      let clear = 0, solid = 0;
      for (let i = 3; i < px.length; i += 4) { if (px[i] < 16) clear++; else if (px[i] > 240) solid++; }
      const total = px.length / 4;
      if (clear < total * 0.05 || solid < total * 0.05) throw new Error(`alpha is not a cut-out: ${(clear / total * 100).toFixed(1)}% clear, ${(solid / total * 100).toFixed(1)}% solid`);
      return `${out.width}x${out.height} RGBA, ${(clear / total * 100).toFixed(0)}% transparent, ${(solid / total * 100).toFixed(0)}% opaque`;
    },
  },
  "upscale-image-esrgan": {
    inputs: { source_image: () => prepare("product-mug-white.jpg", "mug-small.png", 256) }, controls: { scale_by: 0.5 },
    check(files) {
      const out = pngSize(files.image);
      if (out.width !== 512) throw new Error(`expected 512 px wide (256 x 4 x 0.5), got ${out.width}`);
      return `256 -> ${out.width}x${out.height}`;
    },
  },
  "palette-transfer-image": {
    inputs: { source_image: () => prepare("portrait-man-front.jpg", "portrait.png", 512), palette_image: () => prepare("scene-city-street.jpg", "swatch.png", 512) }, controls: { strength: 1 },
    check(files, ctx) {
      const out = pngSize(files.image);
      const mean = (file, w, h) => { const px = rgba(file, w, h); const m = [0, 0, 0]; for (let i = 0; i < px.length; i += 4) { m[0] += px[i]; m[1] += px[i + 1]; m[2] += px[i + 2]; } return m.map((v) => v / (px.length / 4)); };
      const before = mean(ctx.prepared.source_image, out.width, out.height), after = mean(files.image, out.width, out.height), ref = mean(ctx.prepared.palette_image, 512, 512);
      const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (!(dist(after, ref) < dist(before, ref))) throw new Error(`mean color did not move toward the reference (${before.map(Math.round)} -> ${after.map(Math.round)}, ref ${ref.map(Math.round)})`);
      return `mean RGB ${before.map(Math.round)} -> ${after.map(Math.round)} (reference ${ref.map(Math.round)})`;
    },
  },
  "image-face-mosaic-sam3": {
    inputs: { source_image: () => prepare("portrait-woman-studio.jpg", "face.png", 768) }, controls: { target: "face" },
    check(files, ctx) {
      const out = pngSize(files.image);
      const a = rgba(ctx.prepared.source_image, out.width, out.height), b = rgba(files.image, out.width, out.height);
      let changed = 0;
      for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) changed++;
      const share = changed / (a.length / 4);
      if (share < 0.01 || share > 0.4) throw new Error(`${(share * 100).toFixed(1)}% of the picture changed; a face mosaic should touch between 1% and 40%`);
      return `${out.width}x${out.height}, ${(share * 100).toFixed(1)}% of pixels changed`;
    },
  },
  "scene-mesh-moge": {
    inputs: { start_image: () => prepare("scene-living-room.jpg", "room.png", 768) }, controls: { mesh_detail: 2 },
    check(files) {
      const glb = readFileSync(files.model);
      if (glb.toString("ascii", 0, 4) !== "glTF") throw new Error("model is not a GLB");
      if (glb.length < 100_000) throw new Error(`GLB is only ${glb.length} bytes`);
      return `GLB ${(glb.length / 1e6).toFixed(1)} MB`;
    },
  },
};

CASES["video-trim"] = {
  inputs: { source_video: { kind: "video", make: () => prepareClip("clip-ocean-waves.mp4", "ocean.mp4", 480, 5) } }, controls: { start_time: 1, duration: 2 },
  check(files) { const v = probeVideo(files.mp4); if (Math.abs(v.seconds - 2) > 0.35) throw new Error(`expected about 2 s, got ${v.seconds.toFixed(2)} s`); return `${v.width}x${v.height}, ${v.seconds.toFixed(2)} s of a 5 s clip (start 1, length 2), audio ${v.hasAudio ? "kept" : "none"}`; },
};
CASES["video-concat-2"] = {
  inputs: { first_video: { kind: "video", make: () => prepareClip("clip-ocean-waves.mp4", "join-a.mp4", 480, 2) }, second_video: { kind: "video", make: () => prepareClip("clip-traffic.mp4", "join-b.mp4", 480, 2) } }, controls: { width: 640, height: 360 },
  check(files) { const v = probeVideo(files.mp4); if (v.width !== 640 || v.height !== 360) throw new Error(`expected 640x360, got ${v.width}x${v.height}`); if (Math.abs(v.seconds - 4) > 0.5) throw new Error(`expected about 4 s, got ${v.seconds.toFixed(2)} s`); return `${v.width}x${v.height}, ${v.seconds.toFixed(2)} s from two 2 s clips, audio ${v.hasAudio ? "present" : "none"}`; },
};
CASES["kenburns-still"] = {
  inputs: { start_image: () => prepare("scene-city-street.jpg", "street.png", 1280) }, controls: { duration: 3, fps: 24, width: 640, height: 360, zoom_start: 1, zoom_end: 1.5, end_x: 0.7, end_y: 0.4 },
  check(files) {
    const v = probeVideo(files.mp4); if (v.width !== 640 || v.height !== 360) throw new Error(`expected 640x360, got ${v.width}x${v.height}`); if (Math.abs(v.seconds - 3) > 0.2) throw new Error(`expected about 3 s, got ${v.seconds.toFixed(2)} s`);
    const a = join(OUT, "kb-first.png"), b = join(OUT, "kb-last.png");
    ffmpeg(["-i", files.mp4, "-frames:v", "1", a]); ffmpeg(["-sseof", "-0.1", "-i", files.mp4, "-update", "1", "-frames:v", "1", b]);
    const pa = rgba(a, 640, 360), pb = rgba(b, 640, 360); let diff = 0; for (let i = 0; i < pa.length; i += 4) diff += Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
    const mean = diff / (pa.length / 4) / 3; if (mean < 8) throw new Error(`first and last frame are nearly the same (mean difference ${mean.toFixed(1)}): no visible zoom or pan`);
    return `${v.width}x${v.height}, ${v.seconds.toFixed(2)} s at ${v.fps} fps, first/last frame mean difference ${mean.toFixed(1)}/255, audio ${v.hasAudio ? "present" : "none"}`;
  },
};
CASES["video-bg-remove-birefnet"] = {
  inputs: { source_video: { kind: "video", make: () => prepareClip("clip-woman-walking.mp4", "walk.mp4", 320, 1, 12) } }, controls: {},
  check(files) {
    const w = probeVideo(files.webm), m = probeVideo(files.mp4);
    if (!/yuva/.test(w.pixFmt ?? "") && !(w.codec === "vp9")) throw new Error(`cut-out is not a VP9 WebM (${w.codec} ${w.pixFmt})`);
    const alphaMode = ffprobe(files.webm, "stream_tags=alpha_mode").streams?.[0]?.tags?.alpha_mode;
    if (alphaMode !== "1" && !/yuva/.test(w.pixFmt ?? "")) throw new Error("WebM carries no alpha flag");
    return `cut-out ${w.width}x${w.height} ${w.codec} ${w.pixFmt}, alpha_mode ${alphaMode ?? "none"}, ${w.seconds.toFixed(2)} s; matte ${m.width}x${m.height} ${m.seconds.toFixed(2)} s`;
  },
};

const prepared = {};
function prepareClip(fixture, name, width, seconds, fps) {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, name);
  ffmpeg(["-i", join(FIXTURES, fixture), "-t", String(seconds), "-an", ...(fps ? ["-r", String(fps)] : []), "-vf", `scale=${width}:-2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  return file;
}
function prepare(fixture, name, width) {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, name);
  ffmpeg(["-i", join(FIXTURES, fixture), "-vf", `scale=${width}:-2`, "-frames:v", "1", file]);
  return file;
}

async function main() {
  if (process.env.COMFYFIELD_E2E !== "1") {
    console.log("utility-packs-e2e is opt-in: set COMFYFIELD_E2E=1 and start ComfyField + ComfyUI first.");
    return;
  }
  const wanted = process.argv.slice(2);
  const ids = wanted.length ? wanted : Object.keys(CASES);
  mkdirSync(OUT, { recursive: true });
  await call("GET", "/auth/me");
  const [workspace] = await call("GET", "/workspaces");
  const base = `/workspaces/${workspace.id}`;
  const projects = await call("GET", `${base}/projects`);
  const project = projects[0]?.id ?? (await call("POST", `${base}/projects`, { name: "Utility packs E2E" })).id;
  /* These packs have a local route only: never fall back to a cloud worker, which the server refuses and which would cost credits. */
  const worker = (await call("GET", `${base}/workers`)).find((item) => item.enabled && item.kind === "local");
  if (!worker) throw new Error("no enabled local worker");
  const catalogue = await call("GET", `${base}/catalogue`);
  const results = [];
  for (const id of ids) {
    const spec = CASES[id];
    if (!spec) throw new Error(`unknown pack ${id}`);
    const capability = catalogue.find((entry) => entry.id === id);
    if (!capability) throw new Error(`${id} is not in the catalogue`);
    const started = Date.now();
    const inputs = {}, files = {}, ctx = { prepared: {} };
    for (const [key, entry] of Object.entries(spec.inputs)) {
      const { make, kind = "image" } = typeof entry === "function" ? { make: entry } : entry;
      const file = make();
      ctx.prepared[key] = file;
      const form = new FormData();
      form.append("file", new Blob([readFileSync(file)], { type: kind === "video" ? "video/mp4" : "image/png" }), `${id}-${key}.${kind === "video" ? "mp4" : "png"}`);
      inputs[key] = (await call("POST", `${base}/assets?projectId=${project}&kind=${kind}`, undefined, form)).id;
    }
    const run = await call("POST", `${base}/runs`, { projectId: project, workerId: worker.id, idempotencyKey: crypto.randomUUID(), capabilityId: capability.id, version: capability.version, routeId: "local", inputs, controls: spec.controls, audioPolicy: "mute" });
    process.stdout.write(`${id}: run ${run.id} `);
    const done = await waitFor(base, run.id, 25 * 60 * 1000);
    if (done.state !== "succeeded") throw new Error(`${id} ${done.state}: ${done.error ?? JSON.stringify(done).slice(0, 300)}`);
    const provenance = await call("GET", `${base}/runs/${run.id}/provenance`);
    if (provenance.execution !== "local_comfy" || !provenance.workflowHash) throw new Error(`${id}: provenance incomplete`);
    for (const outputId of done.output_ids ?? []) {
      const asset = await call("GET", `${base}/assets/${outputId}`);
      const response = await fetch(`${API}${base}/assets/${outputId}/content`, { headers: { Origin: BASE, cookie: cookieHeader() } });
      if (!response.ok) throw new Error(`${id}: download HTTP ${response.status}`);
      const extension = (asset.name ?? "").split(".").pop() || "bin";
      const kind = extension === "glb" ? "model" : extension === "webm" ? "webm" : extension === "png" ? (files.image ? "extra" : "image") : (files.mp4 ? "mp4b" : "mp4");
      const file = join(OUT, `${id}.${kind === "mp4b" ? "matte." : kind === "extra" ? "extra." : ""}${extension}`);
      writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      files[kind] = file;
    }
    if (!Object.keys(files).length) throw new Error(`${id}: run produced no output`);
    const note = spec.check(files, ctx);
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`\n  OK ${note}; workflow ${provenance.workflowHash.slice(0, 12)}; ${seconds}s`);
    results.push({ id, run: run.id, note, seconds, workflowHash: provenance.workflowHash, files });
  }
  writeFileSync(join(OUT, "receipt.json"), JSON.stringify({ finishedAt: new Date().toISOString(), worker: worker.name ?? worker.id, results }, null, 2) + "\n");
  console.log(`\nutility-packs-e2e OK: ${results.length} pack(s); receipt ${join(OUT, "receipt.json")}`);
}

main().catch((error) => { console.error(`\nutility-packs-e2e FAILED: ${error.message}`); process.exit(1); });

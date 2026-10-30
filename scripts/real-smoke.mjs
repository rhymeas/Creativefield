// Opt-in real ComfyUI smoke: submits shipped graphs to a live ComfyUI server and
// verifies real media comes back. Not part of `npm test` (needs a GPU + installed
// models + FFmpeg). Usage: npm run smoke:real
// Covers: Flux 2 Klein 4B text-to-image (PNG) and Real-ESRGAN video x2 (MP4).
// Env: COMFYUI_URL (default http://127.0.0.1:8188), SMOKE_TIMEOUT_MS.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const base = (process.env.COMFYUI_URL ?? "http://127.0.0.1:8188").replace(/\/$/, "");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 300000);
const run = promisify(execFile);
const fail = (msg) => { console.error(`smoke:real FAIL ${msg}`); process.exit(1); };

async function json(path, init) {
  const res = await fetch(`${base}${path}`, init);
  if (!res.ok) fail(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function submitAndWait(graph, label) {
  const submitted = await json("/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: graph }) });
  const promptId = submitted.prompt_id;
  if (!promptId) fail(`${label}: no prompt_id`);
  console.log(`${label}: prompt ${promptId} queued`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = await json(`/history/${promptId}`);
    const entry = history[promptId];
    if (entry?.status?.status_str === "error") fail(`${label}: execution error: ${JSON.stringify(entry.status.messages ?? []).slice(0, 300)}`);
    if (entry?.outputs && Object.keys(entry.outputs).length) return { promptId, entry };
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail(`${label}: timeout waiting for output`);
}

function outputFile(entry) {
  for (const node of Object.values(entry.outputs ?? {})) {
    for (const item of [...(node.videos ?? []), ...(node.gifs ?? []), ...(node.images ?? [])]) {
      if (item?.filename && (item.type ?? "output") === "output") return item;
    }
  }
  return undefined;
}

async function download(file) {
  const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? "", type: file.type ?? "output" });
  const response = await fetch(`${base}/view?${query}`);
  if (!response.ok) fail(`/view -> HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

const stats = await json("/system_stats").catch(() => fail("ComfyUI unreachable"));
console.log(`comfyui ${stats.system?.comfyui_version ?? "?"} devices=${stats.devices?.length ?? 0}`);

// 1. Text to image, shipped Flux 2 Klein 4B pack.
const flux = JSON.parse(await readFile(new URL("../native-workflows/flux2-klein-t2i/template.api.json", import.meta.url), "utf8"));
flux["76"].inputs.value = "smoke test: a red cabin beside a frozen lake, photographic";
flux["75:73"].inputs.noise_seed = 20261018;
const fluxRun = await submitAndWait(flux, "flux2-klein-t2i");
const image = outputFile(fluxRun.entry);
if (!image) fail("flux2-klein-t2i: no output image");
const pngBytes = await download(image);
const png = pngBytes.length > 24 && pngBytes[0] === 0x89 && pngBytes[1] === 0x50 && pngBytes[2] === 0x4e && pngBytes[3] === 0x47;
const width = png ? new DataView(pngBytes.buffer, pngBytes.byteOffset).getUint32(16) : 0;
const height = png ? new DataView(pngBytes.buffer, pngBytes.byteOffset).getUint32(20) : 0;
if (!png || width !== 1024 || height !== 1024) fail(`flux2-klein-t2i: bad PNG ${pngBytes.length}B ${width}x${height}`);
console.log(`smoke:real OK flux2-klein-t2i PNG ${pngBytes.length}B ${width}x${height} prompt=${fluxRun.promptId}`);

// 2. Video upscale, shipped Real-ESRGAN x2 graph (source 160x90 -> output 320x180).
const work = await mkdtemp(join(tmpdir(), "comfyfield-smoke-"));
try {
  const source = join(work, "source.mp4");
  const output = join(work, "output.mp4");
  try {
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=16:d=1.0625", "-frames:v", "17", "-c:v", "libx264", "-pix_fmt", "yuv420p", source]);
  } catch {
    fail("ffmpeg is required for the Real-ESRGAN smoke");
  }
  const uploadName = `comfyfield-smoke-${Date.now()}.mp4`;
  const form = new FormData();
  form.append("image", new Blob([await readFile(source)], { type: "video/mp4" }), uploadName);
  form.append("type", "input");
  form.append("overwrite", "true");
  const uploaded = await json("/upload/image", { method: "POST", body: form });
  if (!uploaded.name) fail("esrgan-x2: upload failed");

  const esrgan = JSON.parse(await readFile(new URL("../pipelines/enhance/realesrgan-x4/template.api.json", import.meta.url), "utf8"));
  esrgan["1"].inputs.file = uploaded.name;
  esrgan["5"].inputs.scale_by = 0.5;
  esrgan["7"].inputs.filename_prefix = "ComfyField/smoke-esrgan";
  const esrganRun = await submitAndWait(esrgan, "realesrgan-x2");
  const video = outputFile(esrganRun.entry);
  if (!video) fail("realesrgan-x2: no output video");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(output, await download(video));
  let probe;
  try {
    const result = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames,avg_frame_rate", "-of", "json", output]);
    probe = JSON.parse(result.stdout).streams?.[0];
  } catch {
    fail("ffprobe is required to verify the Real-ESRGAN smoke output");
  }
  const frames = Number(probe?.nb_frames);
  if (probe?.width !== 320 || probe?.height !== 180 || frames !== 17 || probe?.avg_frame_rate !== "16/1") {
    fail(`realesrgan-x2: unexpected output ${probe?.width}x${probe?.height} frames=${probe?.nb_frames} fps=${probe?.avg_frame_rate}`);
  }
  console.log(`smoke:real OK realesrgan-x2 MP4 ${probe.width}x${probe.height} frames=${frames} fps=${probe.avg_frame_rate} prompt=${esrganRun.promptId}`);
} finally {
  await rm(work, { recursive: true, force: true });
}

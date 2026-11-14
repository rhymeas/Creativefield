// Phase 1 check: run one real image-to-video job through a provider and save the result.
// Usage: npm run render-test -- [--provider pipelines/i2v/wan22-ti2v-5b] [--image test/assets/render-test.png]
//        [--prompt "..."] [--seconds 2] [--aspect landscape|portrait] [--seed 42]
//        Motion control also takes [--motion-video test/assets/motion-drive.mp4] [--motion-prompt "..."]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ComfyClient, firstOutputFile } from "../src/comfy/client";
import { probe } from "../src/comfy/probe";
import { buildGraph, secondsToWanFrames, type ApiGraph } from "../src/workflow/build";
import { validateManifest, type Manifest } from "../src/workflow/manifest";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const base = (process.env.COMFY_URL ?? "http://127.0.0.1:8188").replace(/\/$/, "");
const folder = arg("provider", "pipelines/i2v/wan22-ti2v-5b");
const imagePath = arg("image", "test/assets/render-test.png");
const prompt = arg("prompt", "The sun sets slowly behind the mountains. Light shimmers on the lake. The camera pushes in gently.");
const seconds = Number(arg("seconds", "2"));
const aspect = arg("aspect", "landscape");
const seed = Number(arg("seed", String(Math.floor(Math.random() * 2 ** 31))));
const motionVideoPath = arg("motion-video", "test/assets/motion-drive.mp4");
const motionPrompt = arg("motion-prompt", "a person dancing");

const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as Manifest;
const template = JSON.parse(readFileSync(join(folder, "template.api.json"), "utf8")) as ApiGraph;

const problems = validateManifest(manifest, template);
if (problems.length) {
  console.error("Manifest does not match its template:", problems);
  process.exit(1);
}

const report = await probe(base);
if (!report.ok) {
  console.error("ComfyUI is not ready. Run `npm run smoke` for details.");
  process.exit(1);
}

// Every model file the manifest lists must be visible to ComfyUI, otherwise the prompt is
// rejected with a less helpful error later.
const info = (await (await fetch(`${base}${report.apiPrefix}/object_info`)).json()) as Record<string, any>;
// Which dropdown lists each models/ subfolder in ComfyUI.
const LOADERS: Record<string, Array<[string, string]>> = {
  diffusion_models: [["UNETLoader", "unet_name"]],
  text_encoders: [["CLIPLoader", "clip_name"]],
  vae: [["VAELoader", "vae_name"]],
  loras: [["LoraLoaderModelOnly", "lora_name"]],
  clip_vision: [["CLIPVisionLoader", "clip_name"]],
};
const offered = (folder: string, file: string) =>
  (LOADERS[folder] ?? []).some(([node, input]) => {
    const spec = info[node]?.input?.required?.[input]?.[0];
    return Array.isArray(spec) && spec.includes(file);
  });
const missing = (manifest.requires?.models ?? []).filter(({ folder, file }) => !offered(folder, file));
if (missing.length) {
  console.error("ComfyUI does not list these model files:", missing.map((m) => `${m.folder}/${m.file}`));
  process.exit(1);
}

const client = new ComfyClient(base);
const imageBytes = readFileSync(imagePath);
const uploaded = await client.uploadImage(new File([imageBytes], basename(imagePath), { type: "image/png" }));
const motionUploaded = manifest.inputs.motion_video
  ? await client.uploadImage(new File([readFileSync(motionVideoPath)], basename(motionVideoPath), { type: "video/mp4" }))
  : undefined;
const graph = buildGraph(template, manifest, {
  prompt,
  negative: "",
  startImage: uploaded,
  motionVideo: motionUploaded,
  motionPrompt: manifest.inputs.motion_prompt ? motionPrompt : undefined,
  resolution: aspect,
  durationSec: seconds,
  seed,
});
const res = manifest.limits.resolutions[aspect];
console.log(
  manifest.inputs.length
    ? `\nProvider ${manifest.id}: ${res.width}x${res.height}, ${seconds}s = ${secondsToWanFrames(seconds, manifest.limits.fps)} frames @ ${manifest.limits.fps} fps, seed ${seed}`
    : `\nProvider ${manifest.id}: ${res.width}x${res.height}, length fixed by the template, seed ${seed}`,
);

const started = Date.now();
let lastPct = -1;
const close = client.connect(
  (e) => {
    if (e.type === "executing" && e.node) console.log(`  node ${e.node} ${graph[e.node]?.class_type ?? ""}`);
    if (e.type === "progress") {
      const pct = Math.floor((e.value / e.max) * 100);
      if (pct !== lastPct && pct % 10 === 0) console.log(`  sampling ${pct}% (${e.value}/${e.max})`);
      lastPct = pct;
    }
    if (e.type === "execution_error") console.error(`  ERROR in node ${e.nodeId}: ${e.message}`);
  },
  () => {},
);
await new Promise((r) => setTimeout(r, 500)); // let the socket open before queueing

const promptId = await client.submitPrompt(graph);
console.log(`queued ${promptId}`);

// Poll history until the job finishes, whatever the socket did.
let entry;
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  entry = await client.history(promptId);
  if (entry?.status?.status_str === "error") {
    console.error("Job failed:", JSON.stringify(entry.status.messages?.slice(-2)));
    close();
    process.exit(1);
  }
  if (entry?.outputs && Object.keys(entry.outputs).length) break;
  if (Date.now() - started > 25 * 60 * 1000) {
    console.error("Timed out after 25 minutes");
    close();
    process.exit(1);
  }
}
close();

const out = firstOutputFile(entry.outputs[manifest.outputs.video.node ?? ""]);
if (!out) {
  console.error("Job finished but the output node produced no file:", JSON.stringify(entry.outputs));
  process.exit(1);
}
const data = new Uint8Array(await (await fetch(client.viewUrl(out))).arrayBuffer());
mkdirSync("renders", { recursive: true });
const dest = join("renders", `${manifest.id}-${seed}-${seconds}s.${out.filename.split(".").pop()}`);
writeFileSync(dest, data);
const secs = ((Date.now() - started) / 1000).toFixed(0);
console.log(`\nDone in ${secs}s. ComfyUI saved ${out.subfolder ? out.subfolder + "/" : ""}${out.filename}; copy at ${dest} (${(data.length / 1024).toFixed(0)} KB)\n`);

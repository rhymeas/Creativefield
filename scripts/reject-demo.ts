// Shows how a real ComfyUI rejection is explained in the studio's own words.
// Submit a job while a model file is missing: ComfyUI refuses it, and nothing is queued.
// Usage: npm run reject-demo   (hide a model file first, e.g. rename wan2.2_vae.safetensors)
import { readFileSync } from "node:fs";
import { ComfyClient, PromptRejectedError } from "../src/comfy/client";
import { buildGraph, type ApiGraph } from "../src/workflow/build";
import { explainPromptError } from "../src/workflow/prompt-errors";
import type { Manifest } from "../src/workflow/manifest";

const folder = "pipelines/i2v/wan22-ti2v-5b";
const manifest = JSON.parse(readFileSync(`${folder}/manifest.json`, "utf8")) as Manifest;
const template = JSON.parse(readFileSync(`${folder}/template.api.json`, "utf8")) as ApiGraph;

const client = new ComfyClient((process.env.COMFY_URL ?? "http://127.0.0.1:8188").replace(/\/$/, ""));
const graph = buildGraph(template, manifest, {
  prompt: "demo",
  negative: "",
  startImage: "example.png",
  resolution: "landscape",
  durationSec: 1,
  seed: 1,
});

try {
  const id = await client.submitPrompt(graph);
  // Nothing was rejected, so this demo has queued a real (1 second) job. Cancel it right away.
  const base = (process.env.COMFY_URL ?? "http://127.0.0.1:8188").replace(/\/$/, "");
  await fetch(`${base}/api/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delete: [id] }),
  });
  await client.interrupt();
  console.log(`ComfyUI accepted the job (${id}), so nothing is missing and there is nothing to explain. The job was cancelled.`);
} catch (e) {
  if (!(e instanceof PromptRejectedError)) throw e;
  const why = explainPromptError(e.rejection, manifest, template);
  console.log(`HTTP ${e.status}: ${e.rejection.error?.message}`);
  console.log(`\n${why.title}`);
  for (const line of why.lines) console.log(`  - ${line}`);
}

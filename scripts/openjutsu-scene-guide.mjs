import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// Prepare an isolated experiment from a compiled local Flash run. The guide
// is a semantic reference shared by all windows. Timed motion stays with the clip.
const [graphPath, guideFilename, outputPath] = process.argv.slice(2);
if (!graphPath || !outputPath || !/^[\w-][\w.-]*\.(?:png|jpe?g|webp)$/i.test(guideFilename ?? "")) {
  throw new Error("Usage: node scripts/openjutsu-scene-guide.mjs <compiled graph> <worker image filename> <new graph>");
}

const graph = JSON.parse(await readFile(graphPath, "utf8"));
const linked = (link, id, port) => Array.isArray(link) && link[0] === id && link[1] === port;
const conditioning = graph["65"];
const plan = graph["35"];
const chain = graph["70"];
const guider = graph["71"];
const sampler = graph["73"];
const guideId = "cf-openjutsu-scene-guide";
const promptId = "cf-openjutsu-scene-guide-prompt";
if (conditioning?.class_type !== "MiniMaxH3ReferenceToVideo" || !conditioning.inputs.vae
  || plan?.class_type !== "MiniMaxH3ChainPlanModern" || !linked(plan.inputs.run_name, "20", 3)
  || chain?.class_type !== "MiniMaxH3ChainContext" || !linked(chain.inputs.conditioning, "65", 0)
  || guider?.class_type !== "BasicGuider" || !linked(guider.inputs.conditioning, "70", 0)
  || sampler?.class_type !== "SamplerCustomAdvanced" || !linked(sampler.inputs.guider, "71", 0)
  || !linked(sampler.inputs.latent_image, "70", 3) || !linked(sampler.inputs.sigmas, "72", 0)
  || graph["72"]?.class_type !== "HyperFlowSigmas" || graph[guideId] || graph[promptId]) {
  throw new Error("Expected the compiled local OpenJutsu Flash chain without an existing scene guide");
}

const references = Object.keys(conditioning.inputs).filter(key => key.startsWith("ref_images.")).sort();
if (references.length < 2 || references.length > 4 || references.some((key, index) => key !== `ref_images.ref_image_${index}`)) {
  throw new Error("Expected two to four connected character references in picture order");
}

// The upstream resume key only hashes source footage and character pictures.
const fingerprint = createHash("sha256").update(JSON.stringify(graph)).update(guideFilename).digest("hex");
plan.inputs.run_name = `swap_scene_guide_${fingerprint.slice(0, 24)}`;
plan.inputs.generation_fingerprint = fingerprint;

graph[guideId] = { class_type: "LoadImage", inputs: { image: guideFilename } };
graph[promptId] = { class_type: "StringConcatenate", inputs: {
  string_a: conditioning.inputs.prompt,
  string_b: `Use <Picture ${references.length + 1}> as a full-scene identity and placement reference. It shows which replacement goes at each person's position. Keep the corresponding individual picture for each replacement's face, body and clothing. Follow <Video 1> for each frame's movement, pose, camera and timing.`,
  delimiter: "\n\n",
} };
conditioning.inputs[`ref_images.ref_image_${references.length}`] = [guideId, 0];
conditioning.inputs.prompt = [promptId, 0];

await writeFile(outputPath, JSON.stringify(graph, null, 2) + "\n", { flag: "wx" });

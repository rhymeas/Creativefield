import type {ApiGraph} from "../workflow/build";
import {h3Frames} from "./timing";

/** Variants of the tested HyperFlow reference-to-video graph.
 * The graph is server-owned; this selects one output, it does not accept nodes from a client.
 */
export type HyperflowQuality = "normal" | "upscale" | "hd-upscale";

const stages = {
  normal: ["11", "13", "14"],
  upscale: ["finish:up-model", "finish:up", "finish:sigmas", "finish:tiled", "finish:decode", "finish:video", "finish:save"],
  "hd-upscale": ["finish:up-model", "finish:up", "finish:sigmas", "anchor", "guide:tiled", "guide:decode", "guide:video", "guide:save"],
} as const;
const common = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "12", "20"] as const;
const expected: Record<string,string> = {
  "1":"HyperFlowGGUFLoader", "2":"CLIPLoader", "3":"VAELoader", "4":"VAELoader",
  "5":"MiniMaxH3ReferenceToVideo", "6":"HyperFlowSigmas", "7":"KSamplerSelect",
  "8":"RandomNoise", "9":"BasicGuider", "10":"SamplerCustomAdvanced", "11":"VAEDecode",
  "12":"VAEDecodeAudio", "13":"CreateVideo", "14":"SaveVideo", "20":"LoadImage",
  "finish:up-model":"LatentUpscaleModelLoader", "finish:up":"MiniMaxH3LatentUpscaleWithModel",
  "finish:sigmas":"ManualSigmas", "finish:tiled":"DenoMiniMaxH3TiledSampler",
  "finish:decode":"VAEDecode", "finish:video":"CreateVideo", "finish:save":"SaveVideo",
  "anchor":"MiniMaxH3AddGuide", "guide:tiled":"DenoMiniMaxH3TiledSampler",
  "guide:decode":"VAEDecode", "guide:video":"CreateVideo", "guide:save":"SaveVideo",
};

/** Select exactly one branch, preserving the tested shared draft, prompt, reference and audio.
 * This does not install or approve the experimental worker's custom nodes.
 */
export function selectHyperflowQuality(template:ApiGraph, quality:HyperflowQuality):ApiGraph {
  if (!Object.hasOwn(stages, quality)) throw new Error("Unknown HyperFlow quality");
  const selected = new Set<string>([...common, ...stages[quality]]);
  for (const id of selected) {
    if (template[id]?.class_type !== expected[id]) throw new Error(`HyperFlow quality template is missing the expected node ${id}`);
  }
  const graph:ApiGraph = {};
  for (const id of selected) graph[id] = structuredClone(template[id]);
  // Validate graph links after pruning so a broken branch cannot silently queue.
  for (const [id,node] of Object.entries(graph)) for (const value of Object.values(node.inputs)) {
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number" && !graph[value[0]]) {
      throw new Error(`HyperFlow quality node ${id} refers to a missing node`);
    }
  }
  return graph;
}

/** Values are supplied only after the server has resolved an uploaded reference. */
export type HyperflowRequest = {
  quality: HyperflowQuality;
  image: string;
  prompt: string;
  seed: number;
  width: number;
  height: number;
  seconds: number;
};

/** Bind a request to the tested workflow; caller must still enforce worker readiness and node policy. */
export function buildHyperflowQuality(template:ApiGraph, request:HyperflowRequest):ApiGraph {
  if (!/^comfyfield-[a-zA-Z0-9_.-]+$/.test(request.image)) throw new Error("Reference image must be resolved by the server");
  if (typeof request.prompt !== "string" || request.prompt.length > 20000) throw new Error("Invalid prompt");
  if (!Number.isSafeInteger(request.seed) || request.seed < 0) throw new Error("Invalid seed");
  if (![request.width, request.height].every(n => Number.isInteger(n) && n >= 256 && n <= 2048 && n % 32 === 0)) throw new Error("Invalid video dimensions");
  if (!Number.isFinite(request.seconds) || request.seconds < 1 || request.seconds > 15) throw new Error("Invalid video duration");
  const graph = selectHyperflowQuality(template, request.quality);
  graph["20"].inputs.image = request.image;
  Object.assign(graph["5"].inputs, {prompt:request.prompt, width:request.width, height:request.height, length:h3Frames(request.seconds,24)});
  graph["8"].inputs.noise_seed = request.seed;
  if (request.quality !== "normal") {
    // Match the tested approximately 1.44x finishing scale, rounded to H3's alignment.
    graph["finish:up"].inputs.width = 32 * Math.round(request.width * 1.44 / 32);
    graph["finish:up"].inputs.height = 32 * Math.round(request.height * 1.44 / 32);
    graph[request.quality === "upscale" ? "finish:tiled" : "guide:tiled"].inputs.seed = request.seed;
  }
  return graph;
}

/** First/last-frame finish, derived from the tested two-reference graph. The HD
 * branch reconstructs conditioning at the output size using both resolved images. */
export function buildHyperflowFirstLastFinish(template:ApiGraph, quality:"upscale"|"hd-upscale"):ApiGraph {
  if (quality !== "upscale" && quality !== "hd-upscale") throw new Error("Unknown first/last finish");
  const commonIds=["1","2","3","4","5","6","7","8","9","10","12","20","21","finish:up-model","finish:up","finish:sigmas"];
  const branch=quality==="upscale"?["finish:tiled","finish:decode","finish:video","finish:save"]:["high-conditioning","guide:tiled","guide:decode","guide:video","guide:save"];
  const classes:Record<string,string>={...expected,"5":"MiniMaxH3ImageToVideo","21":"LoadImage","high-conditioning":"MiniMaxH3ImageToVideo"};
  const graph:ApiGraph={};
  for(const id of [...commonIds,...branch]){
    if(template[id]?.class_type!==classes[id])throw new Error(`HyperFlow first/last finish is missing the expected node ${id}`);
    graph[id]=structuredClone(template[id]);
  }
  const width=Number(graph["5"].inputs.width),height=Number(graph["5"].inputs.height);
  const outputWidth=32*Math.round(width*1.44/32),outputHeight=32*Math.round(height*1.44/32);
  Object.assign(graph["finish:up"].inputs,{width:outputWidth,height:outputHeight});
  const tiled=graph[quality==="upscale"?"finish:tiled":"guide:tiled"];
  tiled.inputs.seed=graph["8"].inputs.noise_seed;
  if(quality==="hd-upscale")graph["high-conditioning"].inputs={...graph["5"].inputs,width:outputWidth,height:outputHeight};
  for(const [id,node] of Object.entries(graph))for(const value of Object.values(node.inputs)){
    if(Array.isArray(value)&&value.length===2&&typeof value[0]==="string"&&typeof value[1]==="number"&&!graph[value[0]])throw new Error(`HyperFlow first/last node ${id} refers to a missing node`);
  }
  return graph;
}

/** Text-only finishing uses the tested FL2VA draft, without inventing a reference image. */
export function selectHyperflowTextFinish(template:ApiGraph, quality:HyperflowQuality):ApiGraph {
  if(quality!=="normal"&&quality!=="upscale"&&quality!=="hd-upscale")throw new Error("Unknown HyperFlow text finish");
  const commonIds=["1","2","3","4","5","6","7","8","9","10","12"];
  const branch=quality==="normal"?["11","13","14"]:["finish:up-model","finish:up","finish:sigmas","finish:tiled","finish:decode","finish:video","finish:save"];
  const classes:Record<string,string>={...expected,"5":"MiniMaxH3ImageToVideo"};
  const graph:ApiGraph={};
  for(const id of [...commonIds,...branch]){
    if(template[id]?.class_type!==classes[id])throw new Error(`HyperFlow text finish is missing the expected node ${id}`);
    graph[id]=structuredClone(template[id]);
  }
  if(quality!=="normal"){
    const width=Number(graph["5"].inputs.width),height=Number(graph["5"].inputs.height);
    // Text has no original HD image to guide the refinement. Use the same
    // Deno pass at a higher output resolution for HD.
    const scale=quality==="hd-upscale"?1.875:1.44;
    Object.assign(graph["finish:up"].inputs,{width:32*Math.round(width*scale/32),height:32*Math.round(height*scale/32)});
    graph["finish:tiled"].inputs.seed=graph["8"].inputs.noise_seed;
  }
  for(const [id,node] of Object.entries(graph))for(const value of Object.values(node.inputs)){
    if(Array.isArray(value)&&value.length===2&&typeof value[0]==="string"&&typeof value[1]==="number"&&!graph[value[0]])throw new Error(`HyperFlow text node ${id} refers to a missing node`);
  }
  return graph;
}

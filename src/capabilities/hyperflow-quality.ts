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

/** Node 7 may be plain Euler or the EasyFix re-noise sampler. The flash create workflows sample natively in two passes
 * (IDEA-2466): node 10a runs euler ancestral on the first two sigmas, node 10 (SamplerCustom) runs SamplerLCM on the
 * rest; 7s splits the sigmas, 7n is the empty negative, 7l the LCM sampler. Every reader of node 10 is unchanged. */
const SAMPLER_CLASSES = new Set(["KSamplerSelect", "H3ImageSampler"]);
const PASS_CLASSES = new Set(["SamplerCustomAdvanced", "SamplerCustom"]);
const NATIVE_PASS: Record<string,string> = {"7s":"SplitSigmas", "7n":"ConditioningZeroOut", "7l":"SamplerLCM", "10a":"SamplerCustomAdvanced"};
const matches = (id:string, actual:string|undefined, wanted:string) => id === "7" ? !!actual && SAMPLER_CLASSES.has(actual) : id === "10" ? !!actual && PASS_CLASSES.has(actual) : actual === wanted;
/** Upscale finishes reach at least this many pixels on the long side. */
export const FINISH_LONG_SIDE = 1472;
/** The image-to-video finishing scale: the tested 1.44x, or more for small drafts so they still finish at 1472 px. */
export const finishScale = (width:number, height:number) => Math.max(1.44, FINISH_LONG_SIDE / Math.max(width, height));
/** "HD upscale" of image to video finishes at 2K: 2048 px on the long side (576x1024 -> 1152x2048, 480x832 -> 1184x2048). */
export const HD_LONG_SIDE = 2048;
export const hdFinishScale = (width:number, height:number) => HD_LONG_SIDE / Math.max(width, height);
/** Output size of a finish, on the 32 px grid the latent upscaler needs. */
export const finishSize = (width:number, height:number, scale:number) => ({width:32*Math.round(width*scale/32), height:32*Math.round(height*scale/32)});

/** Tile layout for the one-step refine (DenoMiniMaxH3TiledSampler). Refine time grows faster than tile area, and every
 * overlap is computed twice, so the frame is cut into the fewest tiles of at most 1184 px across and 1088 px along the
 * long side, overlapping 128 px. Measured on the 4090 (IDEA-2466): 864x1472 in 2 tiles 12.2 s instead of 3 tiles 16.5 s,
 * 1184x2048 in 2 tiles 28 s instead of 10 tiles 66 s; no visible seam; peak memory unchanged (about 9.4 GiB). */
const TILE_OVERLAP = 128;
const axisTile = (length:number, max:number) => {
  if (length <= max) return length;
  const count = Math.ceil((length - TILE_OVERLAP) / (max - TILE_OVERLAP));
  return 32 * Math.ceil((length + (count - 1) * TILE_OVERLAP) / count / 32);
};
export function finishTiles(width:number, height:number) {
  const portrait = height >= width;
  const tile_width = axisTile(width, portrait ? 1184 : 1088), tile_height = axisTile(height, portrait ? 1088 : 1184);
  // The node wants an overlap below the tile size even when one tile covers the axis.
  return {tile_width, tile_height, overlap_x:Math.min(TILE_OVERLAP, tile_width - 32), overlap_y:Math.min(TILE_OVERLAP, tile_height - 32)};
}

/** The native two-pass nodes, when the template has them (all four or none). */
function nativePassIds(template:ApiGraph):string[] {
  const present = Object.keys(NATIVE_PASS).filter(id => template[id]);
  if (!present.length) return [];
  for (const [id, cls] of Object.entries(NATIVE_PASS)) if (template[id]?.class_type !== cls) throw new Error(`HyperFlow native pass is missing the expected node ${id}`);
  return Object.keys(NATIVE_PASS);
}

/** Select exactly one branch, preserving the tested shared draft, prompt, reference and audio.
 * This does not install or approve the experimental worker's custom nodes.
 */
export function selectHyperflowQuality(template:ApiGraph, quality:HyperflowQuality):ApiGraph {
  if (!Object.hasOwn(stages, quality)) throw new Error("Unknown HyperFlow quality");
  const selected = new Set<string>([...common, ...stages[quality], ...nativePassIds(template)]);
  // Optional, server-owned image loaders belong to the shared reference conditioner.
  for (const id of ["ref:1", "ref:2", "ref:3"]) if (template[id]) {
    if (template[id].class_type !== "LoadImage") throw new Error(`Unexpected HyperFlow reference node ${id}`);
    selected.add(id);
  }
  for (const id of selected) {
    if (!matches(id, template[id]?.class_type, expected[id] ?? NATIVE_PASS[id] ?? "LoadImage")) throw new Error(`HyperFlow quality template is missing the expected node ${id}`);
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
  endImage?: string;
  prompt: string;
  seed: number;
  width: number;
  height: number;
  seconds: number;
};

/** Bind a request to the tested workflow; caller must still enforce worker readiness and node policy. */
export function buildHyperflowQuality(template:ApiGraph, request:HyperflowRequest):ApiGraph {
  if (!/^comfyfield-[a-zA-Z0-9_.-]+$/.test(request.image)) throw new Error("Reference image must be resolved by the server");
  if (request.endImage && !/^comfyfield-[a-zA-Z0-9_.-]+$/.test(request.endImage)) throw new Error("End image must be resolved by the server");
  if (typeof request.prompt !== "string" || request.prompt.length > 20000) throw new Error("Invalid prompt");
  if (!Number.isSafeInteger(request.seed) || request.seed < 0) throw new Error("Invalid seed");
  if (![request.width, request.height].every(n => Number.isInteger(n) && n >= 256 && n <= 2048 && n % 32 === 0)) throw new Error("Invalid video dimensions");
  if (!Number.isFinite(request.seconds) || request.seconds < 1 || request.seconds > 15) throw new Error("Invalid video duration");
  const graph = selectHyperflowQuality(template, request.quality);
  graph["20"].inputs.image = request.image;
  Object.assign(graph["5"].inputs, {prompt:request.prompt, width:request.width, height:request.height, length:h3Frames(request.seconds,24)});
  graph["8"].inputs.noise_seed = request.seed;
  if (request.endImage) {
    graph["end:load"]={class_type:"LoadImage",inputs:{image:request.endImage}};
    const guide=(positive:string,latent:string,image:string,frame_idx:number)=>({class_type:"MiniMaxH3AddGuide",inputs:{positive:[positive,0],latent:[latent,1],vae:["3",0],image:[image,0],frame_idx}});
    graph["combined:first"]=guide("5","5","20",0);
    graph["combined:last"]=guide("combined:first","5","end:load",-1);
    graph["9"].inputs.conditioning=["combined:last",0];
    if (request.quality !== "normal") {
      // Build new anchors at the upscaled latent resolution, not the draft resolution.
      graph["combined:hd-first"]={class_type:"MiniMaxH3AddGuide",inputs:{positive:["5",0],latent:["finish:up",0],vae:["3",0],image:["20",0],frame_idx:0}};
      graph["combined:hd-last"]={class_type:"MiniMaxH3AddGuide",inputs:{positive:["combined:hd-first",0],latent:["finish:up",0],vae:["3",0],image:["end:load",0],frame_idx:-1}};
      graph[request.quality==="upscale"?"finish:tiled":"guide:tiled"].inputs.positive=["combined:hd-last",0];
      if(request.quality==="hd-upscale") delete graph.anchor;
    }
  }
  if (request.quality !== "normal") {
    // Upscale: the tested ~1.44x finishing scale, and at least FINISH_LONG_SIDE on the long side, so the small 480x832 /
    // 832x480 drafts finish at 864x1472 in about the time a 576x1024 clip takes without upscale (Fast HD).
    // HD upscale: 2K, 2048 px on the long side, about 25 s more than Fast HD on the 4090 (IDEA-2466).
    const size = finishSize(request.width, request.height, request.quality === "hd-upscale" ? hdFinishScale(request.width, request.height) : finishScale(request.width, request.height));
    Object.assign(graph["finish:up"].inputs, size);
    Object.assign(graph[request.quality === "upscale" ? "finish:tiled" : "guide:tiled"].inputs, {seed:request.seed, ...finishTiles(size.width, size.height)});
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
  for(const id of nativePassIds(template))graph[id]=structuredClone(template[id]);
  for(const id of [...commonIds,...branch]){
    if(!matches(id,template[id]?.class_type,classes[id]))throw new Error(`HyperFlow first/last finish is missing the expected node ${id}`);
    graph[id]=structuredClone(template[id]);
  }
  const width=Number(graph["5"].inputs.width),height=Number(graph["5"].inputs.height);
  const outputWidth=32*Math.round(width*1.44/32),outputHeight=32*Math.round(height*1.44/32);
  Object.assign(graph["finish:up"].inputs,{width:outputWidth,height:outputHeight});
  const tiled=graph[quality==="upscale"?"finish:tiled":"guide:tiled"];
  Object.assign(tiled.inputs,{seed:graph["8"].inputs.noise_seed,...finishTiles(outputWidth,outputHeight)});
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
  for(const id of nativePassIds(template))graph[id]=structuredClone(template[id]);
  for(const id of [...commonIds,...branch]){
    if(!matches(id,template[id]?.class_type,classes[id]))throw new Error(`HyperFlow text finish is missing the expected node ${id}`);
    graph[id]=structuredClone(template[id]);
  }
  if(quality!=="normal"){
    const width=Number(graph["5"].inputs.width),height=Number(graph["5"].inputs.height);
    // Text has no original HD image to guide the refinement. Use the same
    // Deno pass at a higher output resolution for HD.
    const scale=quality==="hd-upscale"?1.875:1.44;
    const size=finishSize(width,height,scale);
    Object.assign(graph["finish:up"].inputs,size);
    Object.assign(graph["finish:tiled"].inputs,{seed:graph["8"].inputs.noise_seed,...finishTiles(size.width,size.height)});
  }
  for(const [id,node] of Object.entries(graph))for(const value of Object.values(node.inputs)){
    if(Array.isArray(value)&&value.length===2&&typeof value[0]==="string"&&typeof value[1]==="number"&&!graph[value[0]])throw new Error(`HyperFlow text node ${id} refers to a missing node`);
  }
  return graph;
}

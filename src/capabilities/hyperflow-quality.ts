import type {ApiGraph} from "../workflow/build";
import {h3Frames} from "./timing";

/** Variants of the tested HyperFlow reference-to-video graph.
 * The graph is server-owned; this selects one output, it does not accept nodes from a client.
 */
export type HyperflowQuality = "normal" | "upscale" | "hd-upscale" | "detail";

const stages = {
  normal: ["11", "13", "14"],
  upscale: ["finish:up-model", "finish:up", "finish:sigmas", "finish:tiled", "finish:decode", "finish:video", "finish:save"],
  "hd-upscale": ["finish:up-model", "finish:up", "finish:sigmas", "anchor", "guide:tiled", "guide:decode", "guide:video", "guide:save"],
  // "detail" is the upscale finish plus the face detail pass (addDetailPass).
  detail: ["finish:up-model", "finish:up", "finish:sigmas", "finish:tiled", "finish:decode", "finish:video", "finish:save"],
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
 * rest; 7s splits the sigmas, 7n is the empty negative, 7l the LCM sampler. Every reader of node 10 is unchanged.
 * Image to video runs plain euler on both passes over the 8-step schedule instead (2026-11-22, DOC-2495): sharper faces,
 * no teal flash in the first frames, about 3 s more; 7l stays in its template unused. */
const SAMPLER_CLASSES = new Set(["KSamplerSelect", "H3ImageSampler"]);
const PASS_CLASSES = new Set(["SamplerCustomAdvanced", "SamplerCustom"]);
const NATIVE_PASS: Record<string,string> = {"7s":"SplitSigmas", "7n":"ConditioningZeroOut", "7l":"SamplerLCM", "10a":"SamplerCustomAdvanced"};
/** Node 2 reads the prompt: the 32B encoder (CLIPLoader) or, since 2026-11-21, Qwen3-VL-4B with a ClipProj projection. */
const ENCODER_CLASSES = new Set(["CLIPLoader", "ClipProjLoader"]);
/** Node 1 loads the model: the reviewed GGUF loader (Q4) or, for image to video since 2026-11-22, the official
 * HyperFlowLoader with the INT8 convrot weights (same quality as Q4 at the 1024 draft, 18-26 s faster;). */
export const HYPERFLOW_LOADER_CLASSES = new Set(["HyperFlowGGUFLoader", "HyperFlowLoader"]);
const matches = (id:string, actual:string|undefined, wanted:string) => id === "7" ? !!actual && SAMPLER_CLASSES.has(actual) : id === "10" ? !!actual && PASS_CLASSES.has(actual) : id === "2" && wanted === "CLIPLoader" ? !!actual && ENCODER_CLASSES.has(actual) : id === "1" ? !!actual && HYPERFLOW_LOADER_CLASSES.has(actual) : actual === wanted;
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
  /** Hold the start picture's colours (image to video only). */
  holdColour?: boolean;
};

/** Daytime clips drift to teal-green within 3-4 s with every sampler and quant we tried; matching every frame's
 * colour statistics to the start picture (core ColorTransfer, mkl in Lab) holds the grade. Measured 2026-11-22 on two
 * golden-hour trailer clips (runs 100a72df, f24a7c11): no teal at the end, motion unchanged, about 25 s more per clip.
 * Off with an end picture, whose colours may differ from the start on purpose. */
const DECODE_TO_VIDEO: Record<HyperflowQuality,[string,string]> = {normal:["11","13"], upscale:["finish:decode","finish:video"], "hd-upscale":["guide:decode","guide:video"], detail:["finish:decode","finish:video"]};
function holdStartColour(graph:ApiGraph, quality:HyperflowQuality) {
  const [decode, video] = DECODE_TO_VIDEO[quality];
  graph["colour:hold"] = {class_type:"ColorTransfer", inputs:{image_target:[decode,0], image_ref:["20",0], method:"mkl_lab", source_stats:"per_frame", strength:1}};
  graph[video].inputs.images = ["colour:hold",0];
}

/** Bind a request to the tested workflow; caller must still enforce worker readiness and node policy. */
export function buildHyperflowQuality(template:ApiGraph, request:HyperflowRequest):ApiGraph {
  if (!/^comfyfield-[a-zA-Z0-9_.-]+$/.test(request.image)) throw new Error("Reference image must be resolved by the server");
  if (request.endImage && !/^comfyfield-[a-zA-Z0-9_.-]+$/.test(request.endImage)) throw new Error("End image must be resolved by the server");
  if (typeof request.prompt !== "string" || request.prompt.length > 20000) throw new Error("Invalid prompt");
  if (!Number.isSafeInteger(request.seed) || request.seed < 0) throw new Error("Invalid seed");
  if (![request.width, request.height].every(n => Number.isInteger(n) && n >= 256 && n <= 2048 && n % 32 === 0)) throw new Error("Invalid video dimensions");
  if (!Number.isFinite(request.seconds) || request.seconds < 1 || request.seconds > 15) throw new Error("Invalid video duration");
  const detail = request.quality === "detail";
  const quality:HyperflowQuality = detail ? "upscale" : request.quality;
  const graph = selectHyperflowQuality(template, quality);
  graph["20"].inputs.image = request.image;
  Object.assign(graph["5"].inputs, {prompt:request.prompt, width:request.width, height:request.height, length:h3Frames(request.seconds,24)});
  graph["8"].inputs.noise_seed = request.seed;
  if (request.endImage) {
    graph["end:load"]={class_type:"LoadImage",inputs:{image:request.endImage}};
    const guide=(positive:string,latent:string,image:string,frame_idx:number)=>({class_type:"MiniMaxH3AddGuide",inputs:{positive:[positive,0],latent:[latent,1],vae:["3",0],image:[image,0],frame_idx}});
    graph["combined:first"]=guide("5","5","20",0);
    graph["combined:last"]=guide("combined:first","5","end:load",-1);
    graph["9"].inputs.conditioning=["combined:last",0];
    if (quality !== "normal") {
      // Build new anchors at the upscaled latent resolution, not the draft resolution.
      graph["combined:hd-first"]={class_type:"MiniMaxH3AddGuide",inputs:{positive:["5",0],latent:["finish:up",0],vae:["3",0],image:["20",0],frame_idx:0}};
      graph["combined:hd-last"]={class_type:"MiniMaxH3AddGuide",inputs:{positive:["combined:hd-first",0],latent:["finish:up",0],vae:["3",0],image:["end:load",0],frame_idx:-1}};
      graph[quality==="upscale"?"finish:tiled":"guide:tiled"].inputs.positive=["combined:hd-last",0];
      if(quality==="hd-upscale") delete graph.anchor;
    }
  }
  if (quality !== "normal") {
    // Upscale: the tested ~1.44x finishing scale, and at least FINISH_LONG_SIDE on the long side, so the small 480x832 /
    // 832x480 drafts finish at 864x1472 in about the time a 576x1024 clip takes without upscale (Fast HD).
    // HD upscale: 2K, 2048 px on the long side, about 25 s more than Fast HD on the 4090 (IDEA-2466).
    const size = finishSize(request.width, request.height, quality === "hd-upscale" ? hdFinishScale(request.width, request.height) : finishScale(request.width, request.height));
    Object.assign(graph["finish:up"].inputs, size);
    Object.assign(graph[quality === "upscale" ? "finish:tiled" : "guide:tiled"].inputs, {seed:request.seed, ...finishTiles(size.width, size.height)});
  }
  if (request.holdColour && !request.endImage) holdStartColour(graph, quality);
  if (detail) addDetailPass(graph, request.prompt, request.seed);
  return graph;
}

/** Detail pass (, atlas). Faces in a group shot and chest logos are too small in the draft to
 * redraw, so the pass works on them alone:
 * - SAM3 finds faces, logos and text on every 6th frame at half size.
 * - The atlas cuts each area into its own piece, enlarges them ~2.5-3x and packs them into ~1.2 MP.
 * - The start-picture crops are the first frame of that canvas (MiniMaxH3AddGuide), and the canvas is redrawn from
 *   sigma 0.7 in three steps, so logos take their letters from the start picture (run dbg-g1s7, 2026-11-22: CF and
 *   Creative Field lettering readable from 0.5 to 4.3 s; the anchor alone at 0.55 did not fix them).
 * - Paste puts the pieces back with a feathered edge.
 * - DLSS 5 (neural rendering, 1x) refines skin and material, composited at 60 % over the frame (detail 0.6): at full strength
 *   the warm yellows turned olive ("muddy", Lab b* 16.2 -> 14.2); 60 % + the colour restore stayed closest to the source
 *   in saturation and contrast on two clips (user pick B, 2026-11-23; DLSS colour 0, natural style or tone 0.5 stayed olive).
 * - ColorTransfer keeps 70 % of each frame's colour statistics from before DLSS: raw DLSS drops saturation by 7-11
 *   (HSV S), 70 % brings it back within +2, 100 % overshoots by +6.
 * Without anything worth enlarging the atlas passes a small dummy canvas and Paste keeps the frames. */
function addDetailPass(graph:ApiGraph, prompt:string, seed:number) {
  const frames = graph["colour:hold"] ? "colour:hold" : "finish:decode";
  Object.assign(graph, {
    "detail:every": {class_type:"VHS_SelectEveryNthImage", inputs:{images:[frames,0], select_every_nth:6, skip_first_images:0}},
    "detail:small": {class_type:"ImageScaleBy", inputs:{image:["detail:every",0], upscale_method:"area", scale_by:0.5}},
    "detail:sam": {class_type:"CheckpointLoaderSimple", inputs:{ckpt_name:"sam3.1_multiplex_fp16.safetensors"}},
    ...detailConcepts(),
    "detail:mask01": {class_type:"MaskComposite", inputs:{destination:["detail:mask0",0], source:["detail:mask1",0], x:0, y:0, operation:"add"}},
    "detail:mask": {class_type:"MaskComposite", inputs:{destination:["detail:mask01",0], source:["detail:mask2",0], x:0, y:0, operation:"add"}},
    "detail:box": {class_type:"CreativeFieldDetailAtlas", inputs:{images:[frames,0], mask:["detail:mask",0], reference:["20",0], megapixels:1.2, max_scale:4, margin:0.15, min_pad:12, max_pieces:10, gutter:32, min_scale:1.25, target_scale:2.4}},
    "detail:all": {class_type:"SolidMask", inputs:{value:1, width:64, height:64}},
    "detail:latent": {class_type:"MiniMaxH3FantasticVideoEditLatent", inputs:{vae:["3",0], images:["detail:box",0], mask:["detail:all",0], grow:0, keep_audio:false, megapixels:0}},
    "detail:cond": {class_type:"MiniMaxH3ReferenceToVideo", inputs:{vae:["3",0], clip:["2",0], audio_vae:["4",0], width:["detail:latent",1], height:["detail:latent",2], length:["detail:latent",3], prompt:`${prompt} Sharp, natural faces with clear eyes; crisp logos.`, ref_image_size:"match", "ref_images.ref_image_0":["detail:box",1]}},
    "detail:negative": {class_type:"ConditioningZeroOut", inputs:{conditioning:["detail:cond",0]}},
    "detail:anchor": {class_type:"MiniMaxH3AddGuide", inputs:{positive:["detail:cond",0], latent:["detail:latent",0], vae:["3",0], image:["detail:box",1], frame_idx:0}},
    "detail:sigmas": {class_type:"ManualSigmas", inputs:{sigmas:"0.7, 0.45, 0.2, 0.0"}},
    "detail:sample": {class_type:"SamplerCustom", inputs:{model:["1",0], add_noise:true, noise_seed:seed, cfg:1, positive:["detail:anchor",0], negative:["detail:negative",0], sampler:["7",0], sigmas:["detail:sigmas",0], latent_image:["detail:latent",0]}},
    "detail:decode": {class_type:"VAEDecode", inputs:{vae:["3",0], samples:["detail:sample",0]}},
    "detail:paste": {class_type:"CreativeFieldDetailAtlasPaste", inputs:{images:[frames,0], detail:["detail:decode",0], plan:["detail:box",2], feather:16}},
    "detail:dlss": {class_type:"RH_DLSS5Enhance", inputs:{image:["detail:paste",0], upscaling_mode:"1x (DLAA / native)", detail:0.6}},
    "detail:colour": {class_type:"ColorTransfer", inputs:{image_target:["detail:dlss",0], image_ref:["detail:paste",0], method:"mkl_lab", source_stats:"per_frame", strength:0.7}},
  });
  graph["finish:video"].inputs.images = ["detail:colour",0];
}

/** One SAM3 track per concept (face, logo, text), each with its own prompt; the masks are combined in addDetailPass. */
function detailConcepts():ApiGraph {
  const concepts = ["face", "logo", "text"];
  const nodes:ApiGraph = {};
  concepts.forEach((text, i) => {
    nodes[`detail:text${i}`] = {class_type:"CLIPTextEncode", inputs:{text, clip:["detail:sam",1]}};
    nodes[`detail:track${i}`] = {class_type:"SAM3_VideoTrack", inputs:{images:["detail:small",0], model:["detail:sam",0], detection_threshold:0.3, max_objects:0, detect_interval:1, conditioning:[`detail:text${i}`,0]}};
    nodes[`detail:mask${i}`] = {class_type:"SAM3_TrackToMask", inputs:{track_data:[`detail:track${i}`,0], object_indices:""}};
  });
  return nodes;
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

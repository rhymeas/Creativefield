import type {ApiGraph} from "../workflow/build";
import type {Port} from "./types";

/**
 * MiniMax H3 Image reads its pictures as <Picture 1>, <Picture 2>, ... in packed slot order: an empty slot is
 * skipped, so the pictures after it move up. The prompt is written against the editor's stable slots
 * (@Image n, or <Picture n> typed by hand, where n is the nth image input), so translate each mention of an
 * attached picture to its packed position. Mentions of empty slots stay as typed.
 * Note: src/team/prompt-reference.ts has a similar promptSlotsToPictures for the video composer (uncommitted
 * at the time of writing); merge the two once it lands.
 */
export function packH3PictureMentions(prompt:string,imagePorts:readonly Port[],inputs:Record<string,string>):string {
  const positions=new Map<number,number>();
  let next=1;
  imagePorts.forEach((port,index)=>{if(inputs[port.id])positions.set(index+1,next++);});
  return prompt.replace(/@Image\s*(\d{1,2})\b|<Picture\s+(\d{1,2})>/gi,(match,mention:string|undefined,picture:string|undefined)=>{
    const position=positions.get(Number(mention??picture));
    return position===undefined?match:`<Picture ${position}>`;
  });
}

/** The format choice that keeps Picture 1's proportions instead of a fixed aspect ratio. */
export const H3_SOURCE_SIZE = "Same as Picture 1";

/**
 * When the format control asks for Picture 1's proportions, the canvas keeps those proportions. With a
 * decoded source size and a chosen megapixel count the canvas is sized to that count on the 32 px grid
 * (the same binary-megapixel rule as the selector); without it the node falls back to Picture 1's own size.
 */
export function applyH3SourceSize(graph:ApiGraph,values:Record<string,unknown>,controls:readonly {id:string;default?:unknown;binding?:{node:string;field:string}}[],sourceSize?:{width:number;height:number}){
  for(const node of Object.values(graph)){
    if(node.class_type!=="MiniMaxH3ImageConditioning")continue;
    const width=node.inputs.width,height=node.inputs.height;
    if(!Array.isArray(width)||!Array.isArray(height)||width[0]!==height[0])continue;
    const selector=String(width[0]);
    const format=controls.find(control=>control.binding?.node===selector&&control.binding.field==="aspect_ratio");
    if(!format||(values[format.id]??format.default)!==H3_SOURCE_SIZE)continue;
    if(!Object.keys(node.inputs).some(field=>field.startsWith("images.")))throw new Error(`${H3_SOURCE_SIZE} needs Picture 1`);
    const megapixels=controls.find(control=>control.id==="megapixels");
    const target=Number(values[megapixels?.id??""]??megapixels?.default);
    if(sourceSize&&Number.isFinite(target)&&target>0){
      const scale=Math.sqrt((target*1024*1024)/(sourceSize.width*sourceSize.height));
      node.inputs.width=Math.max(64,Math.round((sourceSize.width*scale)/32)*32);
      node.inputs.height=Math.max(64,Math.round((sourceSize.height*scale)/32)*32);
    }else{
      node.inputs.width=0;node.inputs.height=0;
    }
    const stillUsed=Object.values(graph).some(other=>other!==node&&Object.values(other.inputs).some(value=>Array.isArray(value)&&value[0]===selector));
    if(!stillUsed)delete graph[selector];
  }
}

/** Apply the translation to every MiniMax H3 Image conditioning prompt in a compiled graph. */
export function applyH3PictureMentions(graph:ApiGraph,ports:readonly Port[],inputs:Record<string,string>){
  const imagePorts=ports.filter(port=>port.type==="image");
  if(!imagePorts.length)return;
  for(const node of Object.values(graph)){
    if(node.class_type!=="MiniMaxH3ImageConditioning"||typeof node.inputs.prompt!=="string")continue;
    node.inputs.prompt=packH3PictureMentions(node.inputs.prompt,imagePorts,inputs);
  }
}

/** ComfyUI's ResolutionSelector caps megapixels at 16; the H3-Image model is good to 20. */
const RESOLUTION_SELECTOR_MAX_MEGAPIXELS = 16;

function megapixelsFromAspect(ratio:number,megapixels:number){
  const width=Math.round(Math.sqrt(megapixels*1024*1024*ratio)/32)*32;
  const height=Math.round(Math.sqrt(megapixels*1024*1024/ratio)/32)*32;
  if(!(width>0)||!(height>0))throw new Error("This model has no valid output size.");
  return {width,height};
}

/**
 * Above this size H3-Image samples a draft first and finishes it at full size (IDEA-2466, 2026-11-21).
 * 12 MP goes through the draft too (user go, 2026-11-22): native 12 MP gave crooked eyes and doubled
 * figures where the 8 MP draft on the same seed (run ce2e13b6) kept the face straight.
 */
export const H3_HIRES_ABOVE_MEGAPIXELS = 8;
/** The draft size of that finish. */
export const H3_HIRES_DRAFT_MEGAPIXELS = 8;
/** Two finishing steps from the official grid: enough to redraw lashes, pores and lettering at full size. */
export const H3_HIRES_SIGMAS = "0.5327739119529724, 0.23200887441635132, 0";
const H3_HIRES_VAE_TILES = {tile_size: 1024, overlap: 64, temporal_size: 64, temporal_overlap: 8};

const canvasOf = (graph:ApiGraph, node:ApiGraph[string]) => {
  const {width, height} = node.inputs;
  if (typeof width === "number" && typeof height === "number") return {width, height};
  if (!Array.isArray(width) || !Array.isArray(height) || width[0] !== height[0]) return undefined;
  const selected = graph[String(width[0])];
  if (selected?.class_type !== "ResolutionSelector") return undefined;
  const ratio = /^\s*(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)/.exec(String(selected.inputs.aspect_ratio ?? ""));
  const megapixels = Number(selected.inputs.megapixels);
  if (!ratio || !Number.isFinite(megapixels)) return undefined;
  return megapixelsFromAspect(Number(ratio[1]) / Number(ratio[2]), megapixels);
};

/**
 * Large H3-Image canvases sample an 8 MP draft, enlarge it in pixels (lanczos), encode it again and redraw
 * the last two steps at full size. Measured on the 4090: 8 -> 16 MP in 70 s, where native 16 MP took over
 * five minutes; lashes, pores and embroidered lettering stay crisp. Enlarging the latent instead leaves
 * doubled edges on lettering, so the enlargement is in pixels. Runs after the canvas size is final.
 */
export function applyH3HiresFinish(graph:ApiGraph){
  for (const node of Object.values(graph)) {
    if (node.class_type !== "MiniMaxH3ImageConditioning") continue;
    const canvas = canvasOf(graph, node);
    // Half a megapixel of slack: the 32 px grid rounds a square slightly above its nominal size (8 MP -> 2912 x 2912).
    if (!canvas || canvas.width * canvas.height <= (H3_HIRES_ABOVE_MEGAPIXELS + 0.5) * 1024 * 1024) continue;
    // The decode that saves the picture, the last sampler before it and the VAE it uses.
    const decodeId = Object.keys(graph).find(key => graph[key].class_type === "VAEDecode" && Array.isArray(graph[key].inputs.samples));
    if (!decodeId) continue;
    const finalId = String((graph[decodeId].inputs.samples as unknown[])[0]);
    const last = graph[finalId];
    if (last?.class_type !== "SamplerCustom") continue;
    const draft = megapixelsFromAspect(canvas.width / canvas.height, H3_HIRES_DRAFT_MEGAPIXELS);
    const selector = Array.isArray(node.inputs.width) ? String(node.inputs.width[0]) : undefined;
    node.inputs.width = draft.width; node.inputs.height = draft.height;
    if (selector && !Object.values(graph).some(other => Object.values(other.inputs).some(value => Array.isArray(value) && value[0] === selector))) delete graph[selector];
    const vae = graph[decodeId].inputs.vae;
    graph["hires:decode"] = {class_type: "VAEDecode", inputs: {samples: [finalId, 0], vae}};
    graph["hires:scale"] = {class_type: "ImageScale", inputs: {image: ["hires:decode", 0], upscale_method: "lanczos", width: canvas.width, height: canvas.height, crop: "disabled"}};
    // Full-size encode and decode go in 1024 px tiles: at 20 MP the whole-frame VAE overflows the 24 GB
    // beside the image model and an encode ran for more than nine minutes; tiled it takes 8 s, no seam seen.
    graph["hires:encode"] = {class_type: "VAEEncodeTiled", inputs: {pixels: ["hires:scale", 0], vae, ...H3_HIRES_VAE_TILES}};
    graph["hires:sigmas"] = {class_type: "ManualSigmas", inputs: {sigmas: H3_HIRES_SIGMAS}};
    graph["hires:sampler"] = {class_type: "SamplerLCM", inputs: {s_noise: 0.95, s_noise_end: 0.95, noise_clip_std: 0}};
    graph["hires:refine"] = {class_type: "SamplerCustom", inputs: {...last.inputs, add_noise: true, noise_seed: Number(last.inputs.noise_seed) + 1, sampler: ["hires:sampler", 0], sigmas: ["hires:sigmas", 0], latent_image: ["hires:encode", 0]}};
    // An edit's draft already holds the change. Its pictures would pull the full-size redraw back towards the source
    // (a black apron faded back to yellow at 20 MP) and their reference blocks made it take 471 s, so the redraw reads
    // the prompt alone. With the 4B encoder that is under a second.
    if (Object.keys(node.inputs).some(field => field.startsWith("images."))) {
      graph["hires:cond"] = {class_type: "MiniMaxH3ImageConditioning", inputs: {clip: node.inputs.clip, prompt: node.inputs.prompt, width: canvas.width, height: canvas.height}};
      graph["hires:neg"] = {class_type: "ConditioningZeroOut", inputs: {conditioning: ["hires:cond", 0]}};
      Object.assign(graph["hires:refine"].inputs, {positive: ["hires:cond", 0], negative: ["hires:neg", 0]});
    }
    graph[decodeId] = {class_type: "VAEDecodeTiled", inputs: {samples: ["hires:refine", 0], vae, ...H3_HIRES_VAE_TILES}};
  }
}

/**
 * Above 16 megapixels the core ResolutionSelector refuses the value. Compute the same canvas
 * (binary megapixels, 32 px grid) from the chosen format and megapixels and write width and
 * height straight into the conditioning node, dropping the unused selector. The 4-16 MP path
 * stays on the selector, exactly as verified.
 */
export function applyH3LargeCanvas(graph:ApiGraph){
  for(const node of Object.values(graph)){
    if(node.class_type!=="MiniMaxH3ImageConditioning")continue;
    const width=node.inputs.width,height=node.inputs.height;
    if(!Array.isArray(width)||!Array.isArray(height)||width[0]!==height[0])continue;
    const selector=String(width[0]);
    const selected=graph[selector];
    if(!selected||selected.class_type!=="ResolutionSelector")continue;
    const megapixels=Number(selected.inputs.megapixels);
    if(!Number.isFinite(megapixels)||megapixels<=RESOLUTION_SELECTOR_MAX_MEGAPIXELS)continue;
    const ratioText=String(selected.inputs.aspect_ratio??"");
    const ratioMatch=/^\s*(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)/.exec(ratioText);
    if(!ratioMatch||Number(ratioMatch[1])<=0||Number(ratioMatch[2])<=0)throw new Error("This model has no valid aspect ratio.");
    const size=megapixelsFromAspect(Number(ratioMatch[1])/Number(ratioMatch[2]),megapixels);
    node.inputs.width=size.width;node.inputs.height=size.height;
    const stillUsed=Object.values(graph).some(other=>other!==node&&Object.values(other.inputs).some(value=>Array.isArray(value)&&value[0]===selector));
    if(!stillUsed)delete graph[selector];
  }
}


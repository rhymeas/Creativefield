import type {CapabilityManifestV2,Port} from "../capabilities/types";

/** A model whose end image is optional: the first/last-frame graph only runs when an end image is given. */
export const END_FRAME_PAIRS:Readonly<Record<string,string>>={"wan22-i2v-14b":"wan22-flf2v-14b","h3-i2v":"h3-flf2v","hyperflow-h3-flash-i2v":"hyperflow-h3-flash-flf2v"};
const PAIRED=new Set([...Object.values(END_FRAME_PAIRS),"h3-flf2v","hyperflow-h3-flash-flf2v-deno"]);
/** The paired model has no place of its own in the model list: it is the same model with an end image. */
export const isEndFrameVariant=(id:string)=>PAIRED.has(id);

/** The first/last-frame sibling of a model, when the catalogue has it. */
export function endFramePair(manifest:CapabilityManifestV2,catalogue:CapabilityManifestV2[]){
  const id=END_FRAME_PAIRS[manifest.id];
  return catalogue.find(m=>m.id===id&&m.coverage.local==="implemented"&&m.inputs.some(p=>p.id==="end_image"));
}

/** The Deno finish has its own requirements; the native first/last graph stays usable without it. */
export function endFrameFinishPair(manifest:CapabilityManifestV2,pair:CapabilityManifestV2|undefined,catalogue:CapabilityManifestV2[],quality:unknown){
  if(manifest.id!=="hyperflow-h3-flash-i2v"||pair?.id!=="hyperflow-h3-flash-flf2v"||quality==="normal")return pair;
  return catalogue.find(m=>m.id==="hyperflow-h3-flash-flf2v-deno"&&m.coverage.local==="implemented")??pair;
}

/** The model as the person sees it: its own inputs plus an optional end image. */
export function withOptionalEndImage(manifest:CapabilityManifestV2,pair:CapabilityManifestV2|undefined):CapabilityManifestV2{
  const end=pair?.inputs.find(p=>p.id==="end_image");
  if(!end||manifest.inputs.some(p=>p.id==="end_image"))return manifest;
  const port:Port={...end,required:false,label:"End image (optional)"};
  return {...manifest,inputs:[...manifest.inputs,port]};
}

/** Which model runs: the first/last-frame one with an end image, the person's own model without one. */
export function endFrameRoute(manifest:CapabilityManifestV2,pair:CapabilityManifestV2|undefined,inputs:Record<string,string>){
  const {end_image,...withoutEnd}=inputs;
  if(pair&&end_image)return {capabilityId:pair.id,version:pair.version,inputs};
  return {capabilityId:manifest.id,version:manifest.version,inputs:pair?withoutEnd:inputs};
}

/** The first/last graph has its own controls; keep the user's prompt, duration and dimensions. */
export function endFrameControls(manifest:CapabilityManifestV2,pair:CapabilityManifestV2|undefined,inputs:Record<string,string>,controls:Record<string,string|number|boolean>):Record<string,string|number|boolean>{
  if(manifest.id!=="hyperflow-h3-flash-i2v"||!pair||!inputs.end_image)return controls;
  const width=Number(controls.width??576),height=Number(controls.height??1024);
  return {prompt:controls.prompt??"",seed:controls.seed??20261031,length:controls.length??3,width,height,steps:6,...(pair.id.endsWith("-deno")?{quality:controls.quality??"upscale"}:{})};
}

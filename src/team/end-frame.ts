import type {CapabilityManifestV2,Port} from "../capabilities/types";

/** A model whose end image is optional: the first/last-frame graph only runs when an end image is given. */
export const END_FRAME_PAIRS:Readonly<Record<string,string>>={"wan22-i2v-14b":"wan22-flf2v-14b"};
const PAIRED=new Set(Object.values(END_FRAME_PAIRS));
/** The paired model has no place of its own in the model list: it is the same model with an end image. */
export const isEndFrameVariant=(id:string)=>PAIRED.has(id);

/** The first/last-frame sibling of a model, when the catalogue has it. */
export function endFramePair(manifest:CapabilityManifestV2,catalogue:CapabilityManifestV2[]){
  const id=END_FRAME_PAIRS[manifest.id];
  return id?catalogue.find(m=>m.id===id&&m.coverage.local==="implemented"&&m.inputs.some(p=>p.id==="end_image")):undefined;
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

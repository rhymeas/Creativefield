import type {CapabilityManifestV2, Readiness} from "../capabilities/types";
import {capabilitySurface} from "../capabilities/surfaces";
import type {Catalogue} from "./api";
import {isMaskedEdit} from "./masked-state";
import {MASK_EDIT_IDEAS} from "./video-mask/edit-ideas";

export type TransformMode="motion"|"swap"|"restyle";

/** The Restyle tab does two things: a whole-clip look, or a new place behind the subject. */
export type RestyleKind="look"|"background";

export const TRANSFORM_MODES:{id:TransformMode;label:string;title:string;text:string}[]=[
  {id:"motion",label:"Copy moves",title:"Copy moves",text:"Your character does the same moves as the person in a video."},
  {id:"swap",label:"Swap a thing",title:"Swap a thing",text:"Mark something in the video and turn it into something else."},
  {id:"restyle",label:"New look",title:"New look",text:"Same video, new style: a cartoon, a painting, night time."},
];

/** Motion transfer routes take a driving performance. Character replacement with
 *  SCAIL-2 lives in the dedicated Video > Replace flow, not in this picker. */
const isMotion=(manifest:CapabilityManifestV2)=>manifest.category==="motion"&&manifest.inputs.some(port=>port.id==="motion_video");
/** Restyle means a video-effect workflow driven by the clip itself. A depth-guided
 *  restyle needs a depth clip the user does not have, so it stays out of this mode. */
const isRestyle=(manifest:CapabilityManifestV2)=>capabilitySurface(manifest)==="video-effect"&&/restyle/i.test(manifest.id)&&manifest.inputs.every(port=>!port.required||port.id==="source_video"||port.type!=="video");

/** Mode-to-capability contract used by the Transform workspace. */
export function transformCandidates(manifests:Catalogue){
  const implemented=manifests.filter(manifest=>manifest.coverage.local==="implemented");
  return {
    motion:implemented.filter(isMotion),
    swap:implemented.filter(isMaskedEdit),
    restyle:implemented.filter(isRestyle),
  };
}

/**
 * Prefer the workflow the user picked inside this tool, then the selected
 * mode, then the remaining modes, and prefer a ready capability over an
 * unready one. A pick only counts inside its own tool; it is not a readiness
 * claim, so the panel still reports what that workflow needs.
 */
export function selectTransformManifest(manifests:Catalogue,statuses:Record<string,Readiness>,mode:TransformMode,picked?:string):CapabilityManifestV2|undefined{
  const candidates=transformCandidates(manifests);
  const chosen=picked?candidates[mode].find(manifest=>manifest.id===picked):undefined;
  if(chosen)return chosen;
  for(const id of [mode,...(["motion","swap","restyle"] as TransformMode[]).filter(item=>item!==mode)]){
    const list=candidates[id];
    if(!list.length)continue;
    return list.find(manifest=>statuses[manifest.id]?.state==="ready")??list[0];
  }
  return undefined;
}

/**
 * A new background reuses the masked-edit route: mark what sits behind the
 * subject, then say what goes there. It is offered only where that route is
 * ready on this computer.
 */
export function backgroundManifest(manifests:Catalogue,statuses:Record<string,Readiness>):CapabilityManifestV2|undefined{
  return transformCandidates(manifests).swap.find(manifest=>statuses[manifest.id]?.state==="ready");
}

/** The starting words for a background change: the same idea the mask tools offer. */
export const BACKGROUND_PROMPT:string=MASK_EDIT_IDEAS.find(idea=>idea.value==="background")!.prompt;

/** The words sit in the browser's saved draft for that masked edit. A chosen New background writes the
 *  background instruction there and leaves words the person already wrote alone. */
function withBackgroundWords(saved:string|null):string{
  let draft:{controls?:Record<string,unknown>;inputs?:Record<string,unknown>}={};
  try{const parsed=JSON.parse(saved??"null");if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))draft=parsed;}catch{}
  const controls=draft.controls??{};
  if(typeof controls.prompt==="string"&&controls.prompt.trim())return saved??"";
  return JSON.stringify({...draft,controls:{...controls,prompt:BACKGROUND_PROMPT},inputs:draft.inputs??{}});
}

/** Choosing New background starts that draft with the background instruction. */
export function seedBackgroundDraft(store:{getItem:(key:string)=>string|null;setItem:(key:string,value:string)=>void},key:string){
  store.setItem(key,withBackgroundWords(store.getItem(key)));
}

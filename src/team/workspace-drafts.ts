import type {CapabilityManifestV2} from "../capabilities/types";
import {routeTask} from "../capabilities/tasks";
import {defaultImageDraft,type ImageDraft} from "../image/image-state";
import type {Worker} from "./api";
import {imageTabFor,type ImageTab,type RunTarget} from "./navigation";

/* Pure helpers of the team workspace (run targets, image tab drafts), kept out of TeamApp.tsx. */

/** A worker's kind comes from the server; the shared Worker type does not carry it yet. */
export const isCloudWorker=(worker:Worker)=>(worker as Worker&{kind?:"local"|"cloud"}).kind==="cloud";
/** A run goes to the chosen target only; this computer stays the default. */
export function targetWorkers(workers:Worker[],target:RunTarget):Worker[]{
  return target==="router"||target==="chatgpt"?[]:target==="cloud"?workers.filter(isCloudWorker):workers.filter(worker=>!isCloudWorker(worker));
}

/** The angle workflow this computer really has ready: the camera-angle tool first, then the 45° angle shots. */
export function angleWorkflow<T extends {id:string}>(ready:T[]):T|undefined{
  return routeTask("image.angles",ready)?.pack;
}
/** The model picker stays within the active Image workspace. */
export function imageModelsForTab<T extends {id:string}>(models:T[],tab:ImageTab):T[]{
  return models.filter(model=>imageTabFor(model.id,"image")===tab);
}
/** A tab starts from its own earlier draft, so its preset is still there when you come back.
    A first visit keeps the picture that is already chosen on the other tab. */
export function imageDraftForTab(manifest:CapabilityManifestV2,remembered:Record<string,ImageDraft>,showing:ImageDraft):ImageDraft{
  const earlier=remembered[manifest.id];
  if(earlier)return earlier;
  const inputs=Object.fromEntries(Object.entries(showing.inputs??{}).filter(([port,asset])=>!!asset&&manifest.inputs.some(input=>input.id===port&&input.type==="image")));
  return Object.keys(inputs).length?{...defaultImageDraft(manifest),inputs}:defaultImageDraft(manifest);
}

/** Carry only values accepted by the new workflow; unsupported controls keep their defaults. */
export function carryCreateDraft(manifest:CapabilityManifestV2,previous:ImageDraft):ImageDraft {
  const next=defaultImageDraft(manifest);
  for(const control of manifest.controls){
    const value=previous.controls[control.id];
    if(value===undefined || !(control.id in next.controls))continue;
    if(control.options && !control.options.includes(value as never))continue;
    if(typeof value==="number" && ((control.min!==undefined&&value<control.min)||(control.max!==undefined&&value>control.max)))continue;
    if(typeof value!==typeof next.controls[control.id])continue;
    next.controls[control.id]=value;
  }
  const inputs=Object.fromEntries(Object.entries(previous.inputs??{}).filter(([id])=>manifest.inputs.some(port=>port.id===id&&port.type==="image")));
  const elementInputs=Object.fromEntries(Object.entries(previous.elementInputs??{}).filter(([id])=>manifest.inputs.some(port=>port.id===id&&port.type==="image")));
  return {...next,...(Object.keys(inputs).length?{inputs}:{}),...(Object.keys(elementInputs).length?{elementInputs}:{})};
}
/** Replace character on Comfy Cloud, in the order the Model row offers them. */
export const CLOUD_REPLACE_MODELS=["scail2-character-replace","cloud-h3-character-swap","cloud-kling-omni-edit","cloud-seedance2-reference"];

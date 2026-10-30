import type {CapabilityManifestV2} from "../../capabilities/types";
import type {Asset} from "../api";
import {matchingMask} from "../masked-state";
export type TwoRegionIntent={projectId:string;workerId:string;idempotencyKey:string;capabilityId:string;version:string;routeId:"local";inputs:{source_video:string;edit_mask:string;edit_mask_2:string};controls:Record<string,string|number|boolean>;audioPolicy:"mute"};
export const twoRegionKey=(user:string,workspace:string,project:string,source:string,firstMask:string)=>`comfyfield:two-region:v1:${user}:${workspace}:${project}:${source}:${firstMask}`;
export function readTwoRegionIntent(value:unknown,projectId:string,sourceId:string,firstMaskId:string,capabilityId:string):TwoRegionIntent|null{
  const v=value as TwoRegionIntent,uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
  if(!v||v.projectId!==projectId||v.capabilityId!==capabilityId||v.inputs?.source_video!==sourceId||v.inputs?.edit_mask!==firstMaskId||!uuid.test(v.inputs?.edit_mask_2??"")||!uuid.test(v.workerId??"")||typeof v.idempotencyKey!=="string"||v.idempotencyKey.length<8||typeof v.version!=="string"||v.routeId!=="local"||v.audioPolicy!=="mute"||!v.controls||typeof v.controls!=="object"||Array.isArray(v.controls))return null;
  if(Object.values(v.controls).some(x=>!["string","number","boolean"].includes(typeof x)||typeof x==="number"&&!Number.isFinite(x)))return null;
  return typeof v.controls.prompt==="string"&&!!v.controls.prompt.trim()&&typeof v.controls.prompt_2==="string"&&!!v.controls.prompt_2.trim()?v:null;
}
export function buildTwoRegionIntent(manifest:CapabilityManifestV2,projectId:string,source:Asset,first:Asset,second:Asset,workerId:string,prompts:[string,string],baseControls:Record<string,unknown>,idempotencyKey:string):TwoRegionIntent{
  if(manifest.mediaContract?.additionalMaskInputs?.join()!=="edit_mask_2"||!matchingMask(first,source,projectId,manifest)||!matchingMask(second,source,projectId,manifest)||prompts.some(p=>!p.trim()))throw Error("Choose two reviewed areas and describe both changes.");
  const controls:TwoRegionIntent["controls"]={};for(const c of manifest.controls){const v=baseControls[c.id];if(v!==undefined&&["string","number","boolean"].includes(typeof v))controls[c.id]=v as string|number|boolean;}
  controls.prompt=prompts[0].trim();controls.prompt_2=prompts[1].trim();if(typeof controls.seed==="number")controls.seed_2=(Math.floor(controls.seed)+1)%2147483648;
  return {projectId,workerId,idempotencyKey,capabilityId:manifest.id,version:manifest.version,routeId:"local",inputs:{source_video:source.id,edit_mask:first.id,edit_mask_2:second.id},controls,audioPolicy:"mute"};
}

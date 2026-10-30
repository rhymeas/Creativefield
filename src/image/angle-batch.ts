import type {CapabilityManifestV2} from "../capabilities/types";
import type {ImageDraft} from "./image-state";
import {imageDraftIssues} from "./image-state";
export type AngleBatch={version:1;id:string;workspaceId:string;projectId:string;userId:string;workerId:string;capabilityId:string;capabilityVersion:string;presetIds:string[];draft:ImageDraft;runIds:Record<string,string>;pendingPreset?:string};
export type AngleScope={workspaceId:string;projectId:string;userId:string;workerId:string};
export const angleBatchStorageKey=(scope:AngleScope,capabilityId="legacy")=>`comfyfield:angle-batch:${scope.userId}:${scope.workspaceId}:${scope.projectId}:${capabilityId}`;
export function freezeAngleBatch(manifest:CapabilityManifestV2,draft:ImageDraft,presets:string[],scope:AngleScope,id:string=crypto.randomUUID()):AngleBatch{
  if(!manifest.routes.some(route=>route.id==="local"&&route.implementation==="implemented")||!manifest.inputs.some(input=>input.required&&input.type==="image")||!scope.workerId||!presets.length||presets.length>8||new Set(presets).size!==presets.length||presets.some(p=>!manifest.presets.some(item=>item.id===p)))throw new Error("Choose between one and eight supported angles.");
  const frozen=JSON.parse(JSON.stringify(draft)) as ImageDraft;
  if(manifest.controls.some(c=>c.id==="batch_size"))frozen.controls.batch_size=1;
  const issue=presets.flatMap(presetId=>imageDraftIssues(manifest,{...frozen,presetId}))[0];if(issue)throw new Error(issue);
  return {version:1,id,...scope,capabilityId:manifest.id,capabilityVersion:manifest.version,presetIds:[...presets],draft:frozen,runIds:{}};
}
export function recoverAngleBatch(value:unknown,manifest:CapabilityManifestV2,scope:AngleScope):AngleBatch|null{
  const v=value as AngleBatch;
  if(!v||v.version!==1||!/^[a-f0-9-]{36}$/i.test(v.id)||v.workspaceId!==scope.workspaceId||v.projectId!==scope.projectId||v.userId!==scope.userId||v.capabilityId!==manifest.id||v.capabilityVersion!==manifest.version||typeof v.workerId!=="string"||!Array.isArray(v.presetIds)||(v.pendingPreset!==undefined&&!v.presetIds.includes(v.pendingPreset))||!v.runIds||typeof v.runIds!=="object"||Object.keys(v.runIds).some(key=>!v.presetIds.includes(key))||Object.values(v.runIds).some(id=>typeof id!=="string"||!/^[a-f0-9-]{36}$/i.test(id)))return null;
  try{freezeAngleBatch(manifest,v.draft,v.presetIds,{...scope,workerId:v.workerId},v.id);return v;}catch{return null;}
}
/** Keep compatible old receipts visible without upgrading their frozen recipe. */
export function recoverAngleBatchForReview(value:unknown,manifest:CapabilityManifestV2,scope:AngleScope):AngleBatch|null{
  const current=recoverAngleBatch(value,manifest,scope);if(current)return current;
  const saved=value as AngleBatch;
  if(typeof saved?.capabilityVersion!=="string"||!/^\d+\.\d+\.\d+$/.test(saved.capabilityVersion))return null;
  return recoverAngleBatch(saved,{...manifest,version:saved.capabilityVersion},scope);
}
/** A different recipe may reconcile only a possibly accepted original request. */
export function angleBatchPendingPresets(batch:AngleBatch,manifest:CapabilityManifestV2):string[]{
  if(batch.capabilityId!==manifest.id)return [];
  if(batch.capabilityVersion!==manifest.version)return batch.pendingPreset&&!batch.runIds[batch.pendingPreset]?[batch.pendingPreset]:[];
  return batch.presetIds.filter(id=>!batch.runIds[id]);
}
export function angleRunRequest(batch:AngleBatch,presetId:string){
  if(!batch.presetIds.includes(presetId))throw new Error("Angle is not part of this saved batch.");
  return {projectId:batch.projectId,workerId:batch.workerId,idempotencyKey:`angles-${batch.id}-${presetId}`,capabilityId:batch.capabilityId,version:batch.capabilityVersion,routeId:"local",inputs:batch.draft.inputs??{},controls:batch.draft.controls,presetId,audioPolicy:"mute"};
}

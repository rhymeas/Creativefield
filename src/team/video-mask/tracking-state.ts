import type {Asset,Run} from "../api";
import {activeRun} from "../state";
import {validTrackingPoints,type PointTrackingSelection} from "./point-selection";
export type TrackingIntent={projectId:string;workerId:string;idempotencyKey:string;capabilityId:string;version:string;routeId:"local";inputs:{source_video:string};elementInputs:Record<string,never>;controls:{threshold?:number};audioPolicy:"mute";tracking:{prompt:string}|PointTrackingSelection};
export const trackingStorageKey=(user:string,workspace:string,project:string,source:string,capability:string)=>`comfyfield:tracking:${user}:${workspace}:${project}:${source}:${capability}`;
export function pendingTrackingIntent(value:unknown,projectId:string,sourceId:string,capabilityId:string):TrackingIntent|null{
  const v=value as TrackingIntent;
  const selection=v?.tracking,valid=selection&&typeof selection==="object"&&!Array.isArray(selection)&&!!v.controls&&typeof v.controls==="object"&&!Array.isArray(v.controls)&&("prompt" in selection?typeof selection.prompt==="string"&&selection.prompt.trim().length>=2&&selection.prompt.length<=200&&Number.isFinite(v.controls.threshold):selection.frameIndex===0&&selection.objectIndex===1&&validTrackingPoints(selection.points)&&Object.keys(v.controls).length===0);
  return v&&v.projectId===projectId&&v.inputs?.source_video===sourceId&&v.capabilityId===capabilityId&&typeof v.idempotencyKey==="string"&&v.idempotencyKey.length>=8&&typeof v.workerId==="string"&&typeof v.version==="string"&&v.routeId==="local"&&v.audioPolicy==="mute"&&valid?v:null;
}
export function recoverableTrackedMasks(assets:Asset[],source:Asset,project:string,capability:string){
  return assets.filter(mask=>{const linked=mask.metadata?.sourceLinkedMask as {sourceAssetId?:string;sourceSha256?:string;workflowId?:string}|undefined,review=mask.metadata?.maskReview as {state?:string}|undefined;return mask.project_id===project&&mask.parent_id===source.id&&mask.media_type==="mask"&&mask.content_type.startsWith("video/")&&!!source.sha256&&linked?.sourceAssetId===source.id&&linked.sourceSha256===source.sha256&&linked.workflowId===capability&&["pending","approved"].includes(review?.state??"");}).sort((a,b)=>{
    const pending=(m:Asset)=>(m.metadata?.maskReview as {state?:string}|undefined)?.state==="pending"?1:0;
    return pending(b)-pending(a)||b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id);
  });
}
export function recoverableTrackingRun(runs:Run[],source:Asset,project:string,capability:string,user:string){
  return runs.filter(r=>{const i=r.invocation as unknown as {inputs?:Record<string,string>;trackingSnapshot?:{sourceSha256?:string}}|undefined;return r.project_id===project&&r.created_by===user&&r.capability_id===capability&&activeRun(r.state)&&i?.inputs?.source_video===source.id&&!!source.sha256&&i.trackingSnapshot?.sourceSha256===source.sha256;}).sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id))[0];
}

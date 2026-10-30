import {z} from "zod";
import type {CapabilityManifestV2} from "../../capabilities/types";
import type {PreservationRecord} from "../../capabilities/edit-preservation";
import type {Asset,Run} from "../../team/api";

export const SCOUT_DESTINATIONS=[
  {id:"forest",label:"Forest",prompt:"A dense pine forest at dawn with light fog"},
  {id:"coast",label:"Coast",prompt:"A quiet sandy coast with blue water in warm afternoon light"},
  {id:"city",label:"City",prompt:"A cinematic city street at night with soft practical lights"},
  {id:"mountains",label:"Mountains",prompt:"An alpine mountain landscape at dusk"},
  {id:"studio",label:"Studio",prompt:"A minimal photography studio with a neutral seamless backdrop"},
] as const;
const frozenAsset=z.object({id:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
export const scoutInputsSchema=z.object({source:frozenAsset,mask:frozenAsset,width:z.number().int().min(8).max(2048).refine(n=>n%8===0),height:z.number().int().min(8).max(2048).refine(n=>n%8===0)});
export type ScoutInputs=z.infer<typeof scoutInputsSchema>;
/** Selection alpha marks the protected subject; opaque white marks editable background. */
export function backgroundPixels(subject:Uint8ClampedArray){
  if(!subject.length||subject.length%4)throw Error("An aligned subject mask is required.");
  const out=new Uint8ClampedArray(subject.length);let protectedPixels=0,editedPixels=0;
  for(let i=0;i<subject.length;i+=4){const value=255-subject[i+3];out[i]=out[i+1]=out[i+2]=value;out[i+3]=255;if(value<128)protectedPixels++;else editedPixels++;}
  if(!protectedPixels||!editedPixels)throw Error("Select a foreground subject with some background left outside it.");
  return out;
}
export type ScoutScope={userId:string;workspaceId:string;projectId:string};
const scoutSchema=z.object({version:z.literal(1),id:z.uuid(),userId:z.string().min(1),workspaceId:z.uuid(),projectId:z.uuid(),workerId:z.uuid(),capabilityVersion:z.string().min(1),routeId:z.string().min(1),inputs:scoutInputsSchema,seed:z.number().int().min(0).max(2147483647),feather:z.number().min(0).max(3),pendingDestination:z.string().refine(id=>SCOUT_DESTINATIONS.some(d=>d.id===id)).optional(),runIds:z.record(z.string(),z.uuid()).refine(ids=>Object.keys(ids).every(id=>SCOUT_DESTINATIONS.some(d=>d.id===id)))});
export type ScoutBatch=z.infer<typeof scoutSchema>;
export const scoutStorageKey=(scope:ScoutScope)=>`comfyfield:environment-scout:v1:${scope.userId}:${scope.workspaceId}:${scope.projectId}`;
export function freezeScout(scope:ScoutScope,manifest:CapabilityManifestV2,workerId:string,routeId:string,inputs:ScoutInputs,feather:number):ScoutBatch{
  if(manifest.id!=="flux2-klein-preserve-edit"||!manifest.editPreservation)throw Error("A ready precision workflow is required.");
  return scoutSchema.parse({version:1,id:crypto.randomUUID(),...scope,workerId,routeId,capabilityVersion:manifest.version,inputs,seed:Math.floor(Math.random()*2147483648),feather,runIds:{}});
}
export function recoverScout(raw:string|null,scope:ScoutScope,manifest:CapabilityManifestV2):ScoutBatch|null{
  try{const batch=scoutSchema.parse(JSON.parse(raw??"null"));return manifest.id==="flux2-klein-preserve-edit"&&!!manifest.editPreservation&&batch.capabilityVersion===manifest.version&&Object.entries(scope).every(([key,value])=>batch[key as keyof ScoutScope]===value)?batch:null;}catch{return null;}
}
export function scoutRunRequest(batch:ScoutBatch,destination:string){
  const place=SCOUT_DESTINATIONS.find(d=>d.id===destination);if(!place)throw Error("Choose a supported destination.");
  return {projectId:batch.projectId,workerId:batch.workerId,idempotencyKey:`scout-${batch.id}-${place.id}`,capabilityId:"flux2-klein-preserve-edit",version:batch.capabilityVersion,routeId:batch.routeId,inputs:{source_image:batch.inputs.source.id,edit_mask:batch.inputs.mask.id},controls:{prompt:`Replace only the selected background with ${place.prompt}. Keep the protected foreground subject, its appearance and its lighting unchanged. Match the background perspective to the subject.`,steps:4,seed:batch.seed,mask_mode:"replace",feather_pct:batch.feather,context_pixels:32},audioPolicy:"mute"};
}
export function scoutPreservation(batch:ScoutBatch,run:Run,asset:Asset):PreservationRecord{
  const p=asset.metadata?.preservation as PreservationRecord|undefined;
  if(run.project_id!==batch.projectId||run.capability_id!=="flux2-klein-preserve-edit"||run.invocation?.inputs?.source_image!==batch.inputs.source.id||run.invocation.inputs.edit_mask!==batch.inputs.mask.id||run.state!=="succeeded"||asset.project_id!==batch.projectId||!run.output_ids.includes(asset.id)||!p||p.kind!=="klein_still_v1"||p.finalAssetId!==asset.id||p.sourceAssetId!==batch.inputs.source.id||!run.output_ids.includes(p.candidateAssetId)||!run.output_ids.includes(p.effectiveMaskAssetId)||p.qa.width!==batch.inputs.width||p.qa.height!==batch.inputs.height)throw Error("This preview has no matching preservation receipt.");
  return p;
}

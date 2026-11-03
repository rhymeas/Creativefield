import type {CapabilityManifestV2} from "../capabilities/types";
import {imageDraftIssues,imageRunBody,type ImageDraft} from "./image-state";
import {ApiError,workspacePath,type Call,type Run} from "../team/api";

export type IdentityPhotosetRecipe={id:string;workspaceId:string;projectId:string;userId:string;workerId:string;model:string;version:string;drafts:ImageDraft[];accepted:Record<number,string>;pending?:number};

/** Retain a saved batch even if the selected worker or workflow version changes. */
export function readIdentityPhotoset(raw:string|null,scope:{userId:string;workspaceId:string;projectId:string;model:string}):IdentityPhotosetRecipe|null{
  try{
    const r=raw?JSON.parse(raw) as IdentityPhotosetRecipe:null;
    return r&&r.workspaceId===scope.workspaceId&&r.projectId===scope.projectId&&r.userId===scope.userId&&r.model===scope.model&&Array.isArray(r.drafts)&&r.drafts.length>=2&&r.drafts.length<=8?r:null;
  }catch{return null;}
}

/** A batch must resume with the worker and graph version it was submitted to. */
export function identityPhotosetCanResume(recipe:IdentityPhotosetRecipe,workerId:string,version:string):boolean{
  return recipe.workerId===workerId&&recipe.version===version;
}

/** Keep Remix batches separate from character photosets without abandoning older character batches. */
export function identityPhotosetStorageKey(scope:{userId:string;workspaceId:string;projectId:string;model:string},variant:"character"|"remix"):string{
  const base=`comfyfield:photoset:${scope.userId}:${scope.workspaceId}:${scope.projectId}:${scope.model}`;
  return variant==="remix"?`${base}:remix`:base;
}

/** A legacy shared batch with an uncertain request must be resolved with its original key first. */
export function hasUnresolvedLegacyPhotoset(raw:string|null,scope:{userId:string;workspaceId:string;projectId:string;model:string}):boolean{
  try{
    const recipe=raw?JSON.parse(raw):null;
    return !!recipe&&recipe.userId===scope.userId&&recipe.workspaceId===scope.workspaceId&&recipe.projectId===scope.projectId&&recipe.model===scope.model&&Number.isInteger(recipe.pending)&&recipe.pending>=0;
  }catch{return false;}
}

export function identityPhotosetWorkerAllowed(localSingleUser:boolean|undefined,origin:string|undefined):boolean{
  if(!localSingleUser||!origin)return false;
  try{return ["localhost","127.0.0.1","[::1]","::1"].includes(new URL(origin).hostname);}catch{return false;}
}
export function identityPhotosetDrafts(manifest:CapabilityManifestV2,draft:ImageDraft,text:string):ImageDraft[]{
  if(!["fibo2-edit","qwen-image-21-edit"].includes(manifest.id))throw new Error("Choose Fibo or Qwen image edit.");
  const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  if(lines.length<2||lines.length>8)throw new Error("Enter two to eight variations, one per line.");
  const base=String(draft.controls.prompt??"").trim();
  return lines.map(line=>{
    const next:ImageDraft={...structuredClone(draft),presetId:undefined,controls:{...draft.controls,prompt:[base,line].filter(Boolean).join("\n\n")}};
    const issue=imageDraftIssues(manifest,next)[0];if(issue)throw new Error(issue);
    return next;
  });
}
export function identityPhotosetRequest(manifest:CapabilityManifestV2,draft:ImageDraft,scope:{projectId:string;workerId:string;id:string},index:number){
  return imageRunBody({projectId:scope.projectId,workerId:scope.workerId,routeId:"local",idempotencyKey:`photoset-${scope.id}-${index}`},manifest,draft);
}

/** Persist before each request; an ambiguous response is retried using the same key. */
export async function submitIdentityPhotoset(initial:IdentityPhotosetRecipe,manifest:CapabilityManifestV2,call:Call,persist:(recipe:IdentityPhotosetRecipe)=>void,stopped:()=>boolean,onAccepted:()=>void):Promise<IdentityPhotosetRecipe>{
  let current=initial;
  for(let index=0;index<current.drafts.length;index++){
    if(stopped())break;
    if(current.accepted[index])continue;
    const previouslyUncertain=current.pending===index;
    current={...current,pending:index};persist(current);
    try{
      const run=await call<Run>(workspacePath(current.workspaceId,"runs"),"POST",identityPhotosetRequest(manifest,current.drafts[index],{projectId:current.projectId,workerId:current.workerId,id:current.id},index));
      current={...current,pending:undefined,accepted:{...current.accepted,[index]:run.id}};persist(current);onAccepted();
    }catch(error){
      if(!previouslyUncertain&&error instanceof ApiError&&error.status>=400&&error.status<500&&error.status!==409){current={...current,pending:undefined};persist(current);}
      throw error;
    }
  }
  return current;
}

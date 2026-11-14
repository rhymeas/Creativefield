import type {CharacterRecord} from "../api";
import {emptyInfluencerDraft,influencerDraftKey,normalizeCastDraft,storedInfluencerDraft,toggleCastMember} from "../influencer/state";

export const characterPath=(workspaceId:string,projectId:string,characterId?:string)=>
  `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/characters${characterId?`/${encodeURIComponent(characterId)}`:""}`;

export function keepCharacterSelection(records:CharacterRecord[],selectedId:string){
  return records.some(record=>record.id===selectedId)?selectedId:records[0]?.id??"";
}

export function updateReferenceSelection(current:string[],assetId:string,checked:boolean,max=16){
  if(!checked)return current.filter(id=>id!==assetId);
  if(current.includes(assetId)||current.length>=max)return current;
  return [...current,assetId];
}

/** The create dialog sends the trimmed name and the optional one-line description the server stores. */
export function characterCreateBody(name:string,description:string,referenceAssetIds:string[],idempotencyKey:string){
  return {idempotencyKey,name:name.trim(),description:description.trim(),referenceAssetIds};
}

/** Rule 33: the empty state offers the next doable step, never a dead end. */
export type CharacterEmptyAction="create"|"add-image"|"none";
export function characterEmptyAction(canCreate:boolean,imageCount:number):CharacterEmptyAction{
  if(!canCreate)return "none";
  return imageCount>0?"create":"add-image";
}

export function requestCharacterDialogClose(busy:boolean,onClose:()=>void){
  if(busy)return false;
  onClose();
  return true;
}

/** Scenes keeps its cast draft in this browser; adding the character there opens Scenes with it selected. */
export function castDraftWithCharacter(stored:unknown,characterId:string){
  const draft=normalizeCastDraft(storedInfluencerDraft(stored)?stored:emptyInfluencerDraft);
  return draft.castIds.includes(characterId)?draft:toggleCastMember(draft,characterId);
}

export function rememberCastMember(userId:string,workspaceId:string,projectId:string,characterId:string){
  try{
    const key=influencerDraftKey(userId,workspaceId,projectId);
    localStorage.setItem(key,JSON.stringify(castDraftWithCharacter(JSON.parse(localStorage.getItem(key)??"null"),characterId)));
  }catch{/* Scenes still opens with whatever draft the browser can show. */}
}

/** Missing usage means an older server, not a proven zero. */
export function characterUsageCaption(usage?:{referenceRuns:number;completedShots:number}):string|undefined{
  if(!usage||!Number.isSafeInteger(usage.completedShots)||usage.completedShots<0||!Number.isSafeInteger(usage.referenceRuns)||usage.referenceRuns<0)return undefined;
  return `${usage.completedShots} tracked ${usage.completedShots===1?"shot":"shots"}`;
}

import {assetMatchesPort} from "../../capabilities/assets";
import type {CapabilityManifestV2} from "../../capabilities/types";
import type {CharacterRecord,ReusableElement} from "../api";
import type {ShotPayload} from "../storyboard-state";
import {defaultDraft} from "../state";

export const MAX_SCENES=20;
export const WORDS_PER_SECOND=2.5;

export type CastScene={key:string;text:string;characterId:string};
export type InfluencerDraft={characterId:string;title:string;script:string;castIds?:string[];scenes?:CastScene[];workflowId?:string};

export const emptyInfluencerDraft:InfluencerDraft={characterId:"",title:"",script:""};

export const influencerDraftKey=(userId:string,workspaceId:string,projectId:string)=>`comfyfield:influencer:${userId}:${workspaceId}:${projectId}`;

export function storedInfluencerDraft(value:unknown):value is InfluencerDraft{
  if(!value||typeof value!=="object")return false;
  const draft=value as Record<string,unknown>;
  return typeof draft.characterId==="string"&&typeof draft.title==="string"&&typeof draft.script==="string"&&(draft.workflowId===undefined||typeof draft.workflowId==="string")&&
    (draft.castIds===undefined||Array.isArray(draft.castIds)&&draft.castIds.length<=16&&new Set(draft.castIds).size===draft.castIds.length&&draft.castIds.every(id=>typeof id==="string"))&&
    (draft.scenes===undefined||Array.isArray(draft.scenes)&&draft.scenes.length<=MAX_SCENES&&draft.scenes.every(s=>s&&typeof s.key==="string"&&typeof s.text==="string"&&typeof s.characterId==="string")&&new Set(draft.scenes.map(s=>s.key)).size===draft.scenes.length);
}

export function normalizeCastDraft(draft:InfluencerDraft):InfluencerDraft&{castIds:string[];scenes:CastScene[]}{
  const scenes=draft.scenes??splitScript(draft.script).map(text=>({key:crypto.randomUUID(),text,characterId:draft.characterId}));
  return {...draft,castIds:draft.castIds??(draft.characterId?[draft.characterId]:[]),scenes,script:scenes.filter(s=>s.text.trim()).map(s=>s.text.trim().replace(/\s+/g," ")).join("\n\n")};
}
export function castDraftWithScenes(draft:InfluencerDraft,scenes:CastScene[]){return {...draft,scenes,script:scenes.filter(s=>s.text.trim()).map(s=>s.text.trim().replace(/\s+/g," ")).join("\n\n")};}
export function toggleCastMember(draft:InfluencerDraft,id:string){
  const d=normalizeCastDraft(draft),castIds=d.castIds.includes(id)?d.castIds.filter(c=>c!==id):[...d.castIds,id];
  if(castIds.length>16)return d;
  // Removing a person never silently assigns their scenes to someone else.
  return {...d,castIds,characterId:castIds[0]??""};
}
export function reorderCast(draft:InfluencerDraft,from:number,to:number){
  const d=normalizeCastDraft(draft);if(from<0||to<0||from>=d.castIds.length||to>=d.castIds.length)return d;
  const castIds=[...d.castIds],id=castIds.splice(from,1)[0];castIds.splice(to,0,id);return {...d,castIds,characterId:castIds[0]??""};
}

/** Boards are named automatically; the user never has to invent a title. */
export const storyboardTitle=(character:CharacterRecord)=>`${character.name} storyboard`;

export function splitScript(script:string):string[]{
  return script.split(/\n\s*\n/).map(scene=>scene.trim().replace(/\s+/g," ")).filter(Boolean);
}

export function estimateSeconds(scene:string):number{
  const words=scene.split(/\s+/).filter(Boolean).length;
  return Math.min(15,Math.max(2,Math.ceil(words/WORDS_PER_SECOND)));
}

export function sceneDurationSeconds(scene:string,manifest?:CapabilityManifestV2){
  const estimate=estimateSeconds(scene),length=manifest?.controls.find(c=>c.id==="length");
  return Math.min(length?.max??estimate,Math.max(length?.min??estimate,estimate));
}

export type PlannedShot={key:string;shot:number;characterId:string;characterName:string;seconds:number};
export type ShotPlan={shots:PlannedShot[];totalSeconds:number};

/** What "Create storyboard" will save: one row per scene that has text, with the person and the length. */
export function shotPlan(draft:InfluencerDraft,characters:CharacterRecord[],manifest?:CapabilityManifestV2):ShotPlan{
  const d=normalizeCastDraft(draft),shots=d.scenes.filter(s=>s.text.trim()).map((scene,index)=>({
    key:scene.key,
    shot:index+1,
    characterId:scene.characterId,
    characterName:(d.castIds.includes(scene.characterId)?characters.find(c=>c.id===scene.characterId)?.name:undefined)??"Pick a person",
    seconds:sceneDurationSeconds(scene.text,manifest),
  }));
  return {shots,totalSeconds:shots.reduce((total,shot)=>total+shot.seconds,0)};
}

export function influencerErrors(draft:InfluencerDraft,characters:CharacterRecord[]):string[]{
  const errors:string[]=[];
  const castIds=draft.castIds??(draft.characterId?[draft.characterId]:[]);
  if(!castIds.length||castIds.some(id=>!characters.some(character=>character.id===id)))errors.push("Choose an existing character.");
  if(draft.scenes?.some(s=>s.text.trim()&&!castIds.includes(s.characterId)))errors.push("Assign each scene to a selected cast member; removing a member does not replace their identity.");
  const scenes=splitScript(draft.script);
  if(!scenes.length)errors.push("Write at least one scene. Separate scenes with a blank line.");
  if(scenes.length>MAX_SCENES)errors.push(`At most ${MAX_SCENES} scenes per storyboard.`);
  return errors;
}

/** The current video contracts bind one identity per scene, never one identity to each temporal endpoint. */
export function buildCastShotPayloads(draft:InfluencerDraft,characters:CharacterRecord[],elements:ReusableElement[],manifest:CapabilityManifestV2):ShotPayload[]{
  const d=normalizeCastDraft(draft),errors=influencerErrors(d,characters);if(errors.length)throw new Error(errors.join(" "));
  return d.scenes.filter(s=>s.text.trim()).map(scene=>{
    const character=characters.find(c=>c.id===scene.characterId),element=elements.find(e=>e.id===character?.elementId);
    if(!character||!d.castIds.includes(character.id)||!characterWorkflowReady(manifest,element))throw new Error("A scene has missing or incompatible character references.");
    return {...buildShotPayloads(character,scene.text.trim().replace(/\s+/g," "),manifest,element)[0],planKey:scene.key};
  });
}

/** First workflow input port the character's Element can actually feed. */
export function characterBinding(manifest:CapabilityManifestV2,element?:ReusableElement):{portId:string;portLabel:string;assetId:string}|null{
  const [binding]=Object.entries(characterBindings(manifest,element)).map(([portId,value])=>({portId,portLabel:manifest.inputs.find(port=>port.id===portId)?.label??portId,assetId:value.assetId}));
  return binding??null;
}

/** Every character reference that can feed a workflow port. Distinct assets are used where possible. */
export function characterBindings(manifest:CapabilityManifestV2,element?:ReusableElement):Record<string,{elementId:string;assetId:string}>{
  if(!element)return {};
  const used=new Set<string>(),bindings:Record<string,{elementId:string;assetId:string}>={};
  for(const port of manifest.inputs){
    const candidates=element.assets.filter(candidate=>assetMatchesPort(candidate,port));
    const asset=candidates.find(candidate=>!used.has(candidate.id));
    if(!asset)continue;
    bindings[port.id]={elementId:element.id,assetId:asset.id};used.add(asset.id);
  }
  return bindings;
}

/** A character workflow must use at least one reference and leave no required input unfilled. */
export function characterWorkflowReady(manifest:CapabilityManifestV2,element?:ReusableElement):boolean{
  const bindings=characterBindings(manifest,element);
  return Object.keys(bindings).length>0&&manifest.inputs.filter(input=>input.required).every(input=>Boolean(bindings[input.id]));
}

export function buildShotPayloads(character:CharacterRecord,script:string,manifest?:CapabilityManifestV2,element?:ReusableElement):ShotPayload[]{
  const bindings=manifest?characterBindings(manifest,element):{};
  const duration=(scene:string)=>sceneDurationSeconds(scene,manifest);
  return splitScript(script).map(scene=>{
    if(!manifest)return {prompt:`${character.name}: ${scene}`,durationSeconds:duration(scene),settings:{audioPolicy:"mute" as const,elementInputs:{}},assets:[]};
    // Mirror storyboard chooseWorkflow: manifest-bound defaults without the
    // prompt/length controls, which the shot itself carries.
    const controls={...defaultDraft(manifest).controls};delete controls.prompt;delete controls.length;
    return {
      prompt:`${character.name}: ${scene}`,
      durationSeconds:duration(scene),
      settings:{
        audioPolicy:manifest.audioPolicies.includes("mute")?"mute":manifest.audioPolicies[0],
        elementInputs:bindings,
        generation:{capabilityId:manifest.id,version:manifest.version,routeId:"local" as const,controls},
      },
      assets:[],
    };
  });
}

import type {CapabilityManifestV2,Readiness,ReadinessState} from "../capabilities/types";
import {isEffectClips,isObjectSwapWorkflow,isOpenJutsuSingleSwap} from "../capabilities/tasks";
import {capabilityReadiness} from "../capabilities/readiness";
import {capabilitySurface as surfaceOf} from "../capabilities/surfaces";
import type {Worker} from "./api";

export function workerReadiness(manifest:CapabilityManifestV2,worker:Worker,now=Date.now(),presetId?:string){
  const fresh=!!worker.checked_at&&now-new Date(worker.checked_at).getTime()<5*60*1000;
  const inventory=worker.inventory??{online:false,nodes:[],models:[],credentials:[]};
  // A cloud worker is judged on the pack's own cloud route when it has one.
  const route=(worker as {kind?:string}).kind==="cloud"&&manifest.routes.some(r=>r.id==="cloud")?"cloud":"local";
  // A plan that may not submit runs makes every pack unavailable there, with Comfy's own reason.
  const blocked=inventory as {canSubmit?:boolean;submitBlockedReason?:string};
  if(blocked.canSubmit===false)return {state:"credentials_required" as const,reasons:[/free tier/i.test(blocked.submitBlockedReason??"")?"Your Comfy plan can't run jobs from CreativeField: Comfy allows API keys on paid plans only. Upgrade your Comfy plan to render here.":blocked.submitBlockedReason??"This Comfy Cloud plan does not allow runs from other apps."],missing:[]};
  return capabilityReadiness(manifest,route,{...inventory,online:worker.enabled&&fresh&&inventory.online},presetId);
}
export function soleReadyWorker(manifest:CapabilityManifestV2,workers:Worker[],presetId?:string):string {
  const available=workers.filter(w=>workerReadiness(manifest,w,undefined,presetId).state==="ready");
  return available.length===1?available[0].id:"";
}
/** Keep the current worker while it can run the selected workflow and settings. */
export function composerReadyWorker(manifest:CapabilityManifestV2,workers:Worker[],presetId?:string,preferredId?:string):string {
  const ready=workers.filter(worker=>workerReadiness(manifest,worker,undefined,presetId).state==="ready");
  return ready.find(worker=>worker.id===preferredId)?.id??ready.sort((a,b)=>a.id.localeCompare(b.id))[0]?.id??"";
}
/** The stock worker can be online while the worker that actually runs HyperFlow is stopped. */
export function composerHyperflowRecoveryWorker(manifest:CapabilityManifestV2,workers:Worker[],presetId?:string):Worker|undefined {
  const usesHyperflow=manifest.routes.some(route=>route.requirements.some(requirement=>requirement.name==="HyperFlowGGUFLoader"));
  if(!usesHyperflow)return;
  return workers.find(worker=>worker.enabled&&worker.can_start&&worker.managed_family==="hyperflow"&&workerReadiness(manifest,worker,undefined,presetId).state==="offline");
}
const readinessRank:Record<ReadinessState,number>={ready:0,unsupported:1,credentials_required:2,download_required:3,install_required:4,incompatible:5,offline:6};
export function bestWorkerReadiness(manifest:CapabilityManifestV2,workers:Worker[],now=Date.now(),presetId?:string):Readiness {
  if(!workers.length)return {state:"offline",reasons:["No local ComfyUI worker is registered."],missing:[]};
  return workers.map(worker=>({worker,result:workerReadiness(manifest,worker,now,presetId)}))
    .sort((a,b)=>readinessRank[a.result.state]-readinessRank[b.result.state]||a.worker.id.localeCompare(b.worker.id))[0].result;
}
export async function refreshWorkerInventory(
  workers:Worker[],canProbe:boolean,probe:(worker:Worker)=>Promise<unknown>,list:()=>Promise<Worker[]>,
):Promise<{workers:Worker[];probeError?:unknown}> {
  let probeError:unknown;
  if(canProbe){const results=await Promise.allSettled(workers.map(worker=>probe(worker)));probeError=results.find(result=>result.status==="rejected")?.reason;}
  return {workers:await list(),...(probeError===undefined?{}:{probeError})};
}
export const runLabel:Record<string,string>={pending:"Pending",submitting:"Submitting",submission_unknown:"Submission uncertain",queued:"Queued",running:"Running",succeeded:"Succeeded",failed:"Failed",cancel_requested:"Cancellation requested",canceled:"Cancelled"};
export function activeRun(state:string){return ["pending","submitting","submission_unknown","queued","running","cancel_requested"].includes(state);}
export type ElementInputBinding={elementId:string;assetId:string};
export type Draft={controls:Record<string,string|number|boolean>;inputs:Record<string,string>;elementInputs:Record<string,ElementInputBinding>;audioPolicy:"preserve"|"replace"|"mix"|"mute";presetId?:string;cameraMove?:string;cameraPose?:{x:number;y:number;zoom:number}};
/** Carry the prompt the user is actually submitting, including an intentional empty value. */
export function draftPromptForHandoff(manifest:CapabilityManifestV2,draft:Draft,promptOn:boolean):string {
  return promptOptional(manifest)&&!promptOn ? "" : String(draft.controls.prompt??"");
}
/** Keep compatible settings when adding a start image changes the HyperFlow graph. */
export function hyperflowImageHandoff(source:CapabilityManifestV2,target:CapabilityManifestV2,current:Draft,next:Draft):Draft {
  if(source.id!=="hyperflow-h3-flash-t2v"||target.id!=="hyperflow-h3-flash-i2v")return next;
  const controls={...next.controls};
  for(const id of ["length","seed","quality"]){
    const setting=target.controls.find(c=>c.id===id&&!c.disabledReason),value=current.controls[id];
    if(!setting||value===undefined)continue;
    if(setting.type==="select"&&setting.options?.includes(value as string|number))controls[id]=value;
    if((setting.type==="number"||setting.type==="integer")&&typeof value==="number"&&Number.isFinite(value)&&(setting.type!=="integer"||Number.isSafeInteger(value))&&(setting.min===undefined||value>=setting.min)&&(setting.max===undefined||value<=setting.max))controls[id]=value;
  }
  const {width,height}=current.controls;
  if(Object.values(target.resolutions??{}).some(size=>size.width===width&&size.height===height)){controls.width=width;controls.height=height;}
  return {...next,controls,audioPolicy:target.audioPolicies.includes(current.audioPolicy)?current.audioPolicy:next.audioPolicy};
}
/** These H3 creation graphs decode generated audio; replace retains that output. */
export function h3GeneratedAudio(m:CapabilityManifestV2){return ["h3-t2v","h3-i2v","h3-flf2v","h3-effects","h3-effects-hyperflow","hyperflow-h3-flash-i2v","hyperflow-h3-flash-t2v","hyperflow-h3-flash-flf2v","previs-to-video-hyperflow"].includes(m.id)&&m.audioPolicies.includes("replace");}
export function defaultDraft(m:CapabilityManifestV2):Draft {
  return {controls:Object.fromEntries(m.controls.filter(c=>!c.disabledReason&&c.default!==undefined).map(c=>[c.id,c.default])) as Draft["controls"],inputs:{},elementInputs:{},audioPolicy:m.voiceContract||h3GeneratedAudio(m)?"replace":m.audioPolicies.includes("preserve")?"preserve":"mute"};
}
/** Restore only fields that still belong to this workflow before replacing an input. */
export function restoreDraft(m:CapabilityManifestV2,saved:unknown):Draft {
  const draft=defaultDraft(m);
  if(!saved||typeof saved!=="object")return draft;
  const data=saved as Partial<Draft>;
  if(data.controls&&typeof data.controls==="object")for(const c of m.controls){const value=data.controls[c.id];if(!c.disabledReason&&value!==undefined&&["string","number","boolean"].includes(typeof value))draft.controls[c.id]=value;}
  if(data.inputs&&typeof data.inputs==="object")for(const p of m.inputs){const value=data.inputs[p.id];if(typeof value==="string")draft.inputs[p.id]=value;}
  if(data.elementInputs&&typeof data.elementInputs==="object")for(const p of m.inputs){const binding=data.elementInputs[p.id];if(binding&&typeof binding.elementId==="string"&&typeof binding.assetId==="string"&&!draft.inputs[p.id])draft.elementInputs[p.id]={elementId:binding.elementId,assetId:binding.assetId};}
  if(data.audioPolicy&&m.audioPolicies.includes(data.audioPolicy))draft.audioPolicy=data.audioPolicy;
  if(typeof data.presetId==="string"&&m.presets.some(preset=>preset.id===data.presetId))draft.presetId=data.presetId;
  if(typeof data.cameraMove==="string")draft.cameraMove=data.cameraMove;
  if(data.cameraPose&&[data.cameraPose.x,data.cameraPose.y,data.cameraPose.zoom].every(Number.isFinite)&&Math.abs(data.cameraPose.x)<=.5&&Math.abs(data.cameraPose.y)<=.5&&data.cameraPose.zoom>=.75&&data.cameraPose.zoom<=2.5)draft.cameraPose=data.cameraPose;
  return draft;
}

/** The prompt is optional only where a picture or clip already carries the subject: the Create screen,
 *  where the words just add a movement or a mood. A masked edit or a voice take says what changes in
 *  words, an effect's words are the instruction, and motion transfer needs them to say what happens. */
export function promptOptional(m:CapabilityManifestV2):boolean{
  if(m.mediaContract||m.voiceContract||m.category==="motion")return false;
  // These prompts are the instruction itself, not an example: the object swap names the thing to change, and
  // OpenJutsu's default tells H3 to put the picture's person into the clip. Sent empty, H3 returned the source unchanged.
  if(isObjectSwapWorkflow(m.id)||isOpenJutsuSingleSwap(m.id)||m.id==="previs-to-video"||m.id==="previs-to-video-hyperflow")return false;
  if(surfaceOf(m)!=="video-create")return false;
  return m.controls.some(c=>c.id==="prompt"&&!c.disabledReason)&&m.inputs.some(port=>port.required);
}
export function draftErrors(m:CapabilityManifestV2,draft:Draft):string[]{
  const errors:string[]=[];
  if(draft.presetId&&!m.presets.some(preset=>preset.id===draft.presetId))errors.push("Choose a supported preset.");
  /** A look preset may carry the whole prompt, and a prompt the workflow does not need may stay empty. */
  const presetPrompt=m.presets.find(preset=>preset.id===draft.presetId)?.values.prompt;
  const presetSetsPrompt=typeof presetPrompt==="string"&&!!presetPrompt.trim();
  const promptOptionalHere=promptOptional(m);
  for(const c of m.controls){
    if(c.disabledReason)continue;
    const value=draft.controls[c.id]??c.default;
    if(c.type==="string"){
      if(typeof value!=="string"||value.length>20000)errors.push(`${c.label}: enter valid text.`);
      else if(c.id==="prompt"&&!value.trim()&&!presetSetsPrompt&&!promptOptionalHere)errors.push(isEffectClips(m.id)?"Choose an effect or describe what should happen.":`${c.label}: enter valid text.`);
    }
    if(["number","integer"].includes(c.type)&&(typeof value!=="number"||!Number.isFinite(value)||(c.type==="integer"&&!Number.isSafeInteger(value))||(c.min!==undefined&&value<c.min)||(c.max!==undefined&&value>c.max)))errors.push(`${c.label}: enter a ${c.type==="integer"?"whole ":""}number${c.min!==undefined?` from ${c.min}`:""}${c.max!==undefined?` to ${c.max}`:""}.`);
    if(c.type==="select"&&!c.options?.includes(value as string|number))errors.push(`${c.label}: choose a supported option.`);
    if(c.type==="boolean"&&typeof value!=="boolean")errors.push(`${c.label}: choose on or off.`);
  }
  if(m.resolutions&&!Object.values(m.resolutions).some(s=>s.width===draft.controls.width&&s.height===draft.controls.height))errors.push("Choose a supported frame size.");
  return errors;
}
export function draftKey(user:string,workspace:string,project:string,capability:string){return `comfyfield:team-draft:v1:${user}:${workspace}:${project}:${capability}`;}
/** An uncertain request remains the same intent until resolved or explicitly abandoned. */
export function submissionIntent<T>(body:T,key:string=crypto.randomUUID()){return {...body,idempotencyKey:key};}

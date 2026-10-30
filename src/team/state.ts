import type {CapabilityManifestV2,Readiness,ReadinessState} from "../capabilities/types";
import {capabilityReadiness} from "../capabilities/readiness";
import {capabilitySurface as surfaceOf} from "../capabilities/surfaces";
import type {Worker} from "./api";

export function workerReadiness(manifest:CapabilityManifestV2,worker:Worker,now=Date.now()){
  const fresh=!!worker.checked_at&&now-new Date(worker.checked_at).getTime()<5*60*1000;
  const inventory=worker.inventory??{online:false,nodes:[],models:[],credentials:[]};
  // A cloud worker is judged on the pack's own cloud route when it has one.
  const route=(worker as {kind?:string}).kind==="cloud"&&manifest.routes.some(r=>r.id==="cloud")?"cloud":"local";
  // A plan that may not submit runs makes every pack unavailable there, with Comfy's own reason.
  const blocked=inventory as {canSubmit?:boolean;submitBlockedReason?:string};
  if(blocked.canSubmit===false)return {state:"credentials_required" as const,reasons:[blocked.submitBlockedReason??"This Comfy Cloud plan does not allow runs from other apps."],missing:[]};
  return capabilityReadiness(manifest,route,{...inventory,online:worker.enabled&&fresh&&inventory.online});
}
export function soleReadyWorker(manifest:CapabilityManifestV2,workers:Worker[]):string {
  const available=workers.filter(w=>workerReadiness(manifest,w).state==="ready");
  return available.length===1?available[0].id:"";
}
const readinessRank:Record<ReadinessState,number>={ready:0,unsupported:1,credentials_required:2,download_required:3,install_required:4,incompatible:5,offline:6};
export function bestWorkerReadiness(manifest:CapabilityManifestV2,workers:Worker[],now=Date.now()):Readiness {
  if(!workers.length)return {state:"offline",reasons:["No local ComfyUI worker is registered."],missing:[]};
  return workers.map(worker=>({worker,result:workerReadiness(manifest,worker,now)}))
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
export type Draft={controls:Record<string,string|number|boolean>;inputs:Record<string,string>;elementInputs:Record<string,ElementInputBinding>;audioPolicy:"preserve"|"replace"|"mix"|"mute";presetId?:string};
export function defaultDraft(m:CapabilityManifestV2):Draft {
  return {controls:Object.fromEntries(m.controls.filter(c=>!c.disabledReason&&c.default!==undefined).map(c=>[c.id,c.default])) as Draft["controls"],inputs:{},elementInputs:{},audioPolicy:m.voiceContract?"replace":m.audioPolicies.includes("preserve")?"preserve":"mute"};
}
/** The prompt is optional only where a picture or clip already carries the subject: the Create screen,
 *  where the words just add a movement or a mood. A masked edit or a voice take says what changes in
 *  words, an effect's words are the instruction, and motion transfer needs them to say what happens. */
export function promptOptional(m:CapabilityManifestV2):boolean{
  if(m.mediaContract||m.voiceContract||m.category==="motion")return false;
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
    if(c.type==="string"&&(typeof value!=="string"||value.length>20000||(c.id==="prompt"&&!value.trim()&&!presetSetsPrompt&&!promptOptionalHere)))errors.push(`${c.label}: enter valid text.`);
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

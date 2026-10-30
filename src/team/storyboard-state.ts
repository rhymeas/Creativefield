import type {CapabilityManifestV2} from "../capabilities/types";
import {hasQualifiedDurationMapping} from "../capabilities/timing";
import {assetMatchesPort} from "../capabilities/assets";
import type {Asset,ReusableElement,Worker} from "./api";
import {defaultDraft,draftErrors,workerReadiness,type ElementInputBinding} from "./state";

export type Shot={key:string;prompt:string;durationSeconds:number|string;settings:{title?:string;audioPolicy:"mute"|"preserve"|"replace"|"mix";elementInputs:Record<string,ElementInputBinding>;cameraHint?:string;capabilityId?:string;generation?:{capabilityId:string;version:string;routeId:"local";controls:Record<string,string|number|boolean>}};assets:Array<{role:string;assetId:string}>};
export type ShotPayload=Omit<Shot,"key"|"durationSeconds">&{durationSeconds:number;planKey?:string};
export type Board={id:string;project_id:string;name:string;revision:number;shots?:Array<{id:string;plan_key?:string;ordinal:number;prompt:string;duration_seconds:number|string;settings:Shot["settings"];assets:Shot["assets"]}>};
export type Assembly={width:number;height:number;fps:number;audioPolicy:"mute"|"preserve";/** Absent means hard cuts. A cross-fade overlaps neighbours and shortens the film. */transition?:{kind:"cut"|"crossfade";seconds:number}};
export type BoardDraft={revision:number;shots:Shot[];workerId:string;assembly:Assembly};
export type SaveIntent={revision:number;shots:ShotPayload[]};
export type RenderIntent={revision:number;workerId:string;idempotencyKey:string;assembly:Assembly;approvedStillTakes?:Record<string,string>};
export type BoardRender={id:string;project_id:string;created_by:string;revision:number;state:string;error:string|null;output_asset_id:string|null;created_at:string;assembly:Assembly;shots?:Array<{ordinal:number;snapshot:{planKey?:string;approvedStill?:{producerRunId:string;assetId:string;takeId:string};prompt:string;frames:number;effectiveDurationSeconds:number};state:string|null;error:string|null;child_run_id:string|null;output_asset_id:string|null;scene?:number|null;shot?:number|null;take?:number|null}>};
export type AssemblyReadiness={state:string;missing:string[];instructions:string};
export const defaultAssembly:Assembly={width:1280,height:720,fps:24,audioPolicy:"mute"};
export const outputSizes=[{id:"landscape",label:"16:9 · 1280 × 720",width:1280,height:720},{id:"portrait",label:"9:16 · 720 × 1280",width:720,height:1280},{id:"square",label:"1:1 · 1024 × 1024",width:1024,height:1024}];
export function eligible(m:CapabilityManifestV2){return m.coverage.local==="implemented"&&["t2v","i2v","flf2v"].includes(m.category)&&hasQualifiedDurationMapping(m);}
/** Same rule assembly applies (server/assembly.ts), so a join that cannot be built is refused before generation. */
export function transitionProblem(shots:Array<{durationSeconds:number|string}>,transition?:Assembly["transition"]):string|undefined{
  const fade=transition?.kind==="crossfade"?transition.seconds:0;
  if(!(fade>0))return;
  if(shots.length<2)return "A cross-fade needs at least two shots.";
  const durations=shots.map(s=>Number(s.durationSeconds)).filter(n=>Number.isFinite(n)&&n>0);
  if(durations.length<shots.length)return; // An unusable duration is reported on its shot.
  const shortest=Math.min(...durations);
  if(fade>=shortest)return `A ${fade} s cross-fade is longer than the shortest shot.`;
}
export function boardDraftKey(user:string,workspace:string,project:string,board:string){return `comfyfield:board:v1:${user}:${workspace}:${project}:${board}`;}
export function fromBoard(board:Board):BoardDraft{return {revision:board.revision,shots:(board.shots??[]).map(s=>({key:s.plan_key??s.id,prompt:s.prompt,durationSeconds:Number(s.duration_seconds),settings:{...structuredClone(s.settings),elementInputs:structuredClone(s.settings.elementInputs??{})},assets:structuredClone(s.assets)})),workerId:"",assembly:{...defaultAssembly}};}
export function newShot(m?:CapabilityManifestV2):Shot{
  const shot:Shot={key:crypto.randomUUID(),prompt:"",durationSeconds:1,settings:{audioPolicy:"mute",elementInputs:{}},assets:[]};return m?chooseWorkflow(shot,m):shot;
}
/** Explicit model selection resets only model-specific controls/references. */
export function chooseWorkflow(shot:Shot,m:CapabilityManifestV2):Shot{
  const d=defaultDraft(m);delete d.controls.prompt;delete d.controls.length;
  return {...shot,durationSeconds:m.controls.find(c=>c.id==="length")?.default as number??1,settings:{...shot.settings,generation:{capabilityId:m.id,version:m.version,routeId:"local",controls:d.controls},audioPolicy:m.audioPolicies.includes("mute")?"mute":m.audioPolicies[0],elementInputs:{}},assets:[]};
}
export function moveShot(shots:Shot[],from:number,to:number){if(from<0||to<0||from>=shots.length||to>=shots.length)return shots;const next=[...shots],item=next.splice(from,1)[0];next.splice(to,0,item);return next;}
export function shotPayload(shots:Shot[]):ShotPayload[]{return shots.map(({key,...s})=>({...s,planKey:key,durationSeconds:Number(s.durationSeconds),settings:structuredClone(s.settings),assets:[...s.assets].sort((a,b)=>a.role.localeCompare(b.role))}));}
function canonical(value:unknown):string{if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;if(value&&typeof value==="object")return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;return JSON.stringify(value);}
export function equalShots(a:Shot[],b:Shot[]){return canonical(shotPayload(a))===canonical(shotPayload(b));}
export function saveOutcome(intent:SaveIntent,board:Board):"saved"|"retry"|"conflict"{
  if(board.revision===intent.revision)return "retry";
  // A pre-upgrade in-flight save has no plan keys; reconcile its content once.
  const comparable=(shots:ShotPayload[])=>intent.shots.every(s=>!s.planKey)?shots.map(({planKey:_planKey,...s})=>s):shots;
  if(board.revision===intent.revision+1&&canonical(comparable(shotPayload(fromBoard(board).shots)))===canonical(comparable(intent.shots)))return "saved";
  return "conflict";
}
export function storedDraft(value:unknown):value is BoardDraft{
  const d=value as BoardDraft;if(d&&Array.isArray(d.shots))for(const shot of d.shots)if(shot?.settings&&shot.settings.elementInputs===undefined)shot.settings.elementInputs={};
  return !!d&&Number.isInteger(d.revision)&&d.revision>0&&Array.isArray(d.shots)&&d.shots.length<=100&&typeof d.workerId==="string"&&!!d.assembly&&["mute","preserve"].includes(d.assembly.audioPolicy)&&[24,25,30,60].includes(d.assembly.fps)&&[d.assembly.width,d.assembly.height].every(n=>Number.isInteger(n)&&n>=64&&n<=1920&&n%2===0)&&d.shots.every(s=>s&&typeof s.key==="string"&&typeof s.prompt==="string"&&["number","string"].includes(typeof s.durationSeconds)&&s.settings&&(s.settings.title===undefined||(typeof s.settings.title==="string"&&s.settings.title.length<=500))&&["mute","preserve","replace","mix"].includes(s.settings.audioPolicy)&&!!s.settings.elementInputs&&typeof s.settings.elementInputs==="object"&&Object.values(s.settings.elementInputs).every(binding=>binding&&typeof binding.elementId==="string"&&typeof binding.assetId==="string")&&(!s.settings.generation||(typeof s.settings.generation.capabilityId==="string"&&typeof s.settings.generation.version==="string"&&s.settings.generation.routeId==="local"&&!!s.settings.generation.controls&&typeof s.settings.generation.controls==="object"))&&Array.isArray(s.assets)&&s.assets.every(a=>typeof a.role==="string"&&typeof a.assetId==="string"));
}
export function shotErrors(s:Shot,catalogue:CapabilityManifestV2[],assets:Asset[],elements:ReusableElement[]=[]):string[]{
  if(s.settings.title!==undefined&&(typeof s.settings.title!=="string"||s.settings.title.length>500))return ["Use a shot title of up to 500 characters."];
  const g=s.settings.generation,m=catalogue.find(m=>m.id===g?.capabilityId);
  if(!g||!m||!eligible(m)||g.version!==m.version)return ["Choose a supported local workflow revision."];
  const controls={...g.controls,prompt:s.prompt,length:s.durationSeconds},inputs=Object.fromEntries(s.assets.map(a=>[a.role,a.assetId]));
  const errors=draftErrors(m,{controls,inputs,elementInputs:s.settings.elementInputs,audioPolicy:s.settings.audioPolicy});
  if(!m.audioPolicies.includes(s.settings.audioPolicy))errors.push("Choose a supported shot audio policy.");
  if(s.settings.cameraHint?.trim())errors.push("Camera hint is unbound. Copy it into the prompt or clear it explicitly.");
  if("prompt" in g.controls||"length" in g.controls||Object.keys(g.controls).some(id=>!m.controls.some(c=>c.id===id&&!c.disabledReason)))errors.push("Stored controls are incompatible; choose the workflow again to reset them.");
  for(const p of m.inputs)if(p.required&&!inputs[p.id]&&!s.settings.elementInputs[p.id])errors.push(`${p.label} is required.`);
  for(const a of s.assets){const p=m.inputs.find(p=>p.id===a.role);if(!p||!assets.some(v=>v.id===a.assetId&&assetMatchesPort(v,p)))errors.push(`${a.role}: choose available shared media.`);if(s.settings.elementInputs[a.role])errors.push(`${a.role}: choose direct media or an Element asset, not both.`);}
  for(const [role,binding] of Object.entries(s.settings.elementInputs)){const p=m.inputs.find(port=>port.id===role),element=elements.find(item=>item.id===binding.elementId),asset=element?.assets.find(item=>item.id===binding.assetId);if(!p||!asset||!assetMatchesPort(asset,p))errors.push(`${p?.label??role}: choose an available compatible Element asset.`);}
  return errors;
}
export function boardRequirements(shots:Shot[],catalogue:CapabilityManifestV2[],worker?:Worker){
  if(!worker)return ["Choose a worker for this board."];
  return [...new Set(shots.flatMap(s=>{const m=catalogue.find(m=>m.id===s.settings.generation?.capabilityId);return m?workerReadiness(m,worker).reasons:["Choose a workflow for each shot."];}))];
}
export const renderActive=(state:string)=>["pending","generating","assembling","cancel_requested"].includes(state);
export const boardRenderLabels:Record<string,string>={pending:"Pending",generating:"Generating shots",assembling:"Assembling",assembly_failed:"Assembly needs attention",succeeded:"Complete",failed:"Failed",cancel_requested:"Cancellation requested",canceled:"Cancelled"};

/* Replace character and Swap a thing take several runs in a row. Their place is kept in this tab's browser
   storage: the request id that names every step's idempotency key, the step that is open next, and each step's
   run id and output. After a reload the panel puts the form back and carries on at the open step, so finished
   steps are not run again. No UI here, so a saved chain is testable without a browser. */
import {workspacePath,type Call,type Run} from "./api";
import {activeRun} from "./state";
import type {ReplaceStep} from "./reference-replace";

export type ChainTool="replace"|"swap"|"edit";
/** The parts of browser storage this module touches, so a test can pass a plain object. */
export type ChainStorage=Pick<Storage,"getItem"|"setItem"|"removeItem">;

/** One open chain per tool, project and tab. */
export const chainKey=(tool:ChainTool,workspaceId:string,projectId:string)=>`comfyfield:chain:${tool}:${workspaceId}:${projectId}`;

/** A face the Replace panel holds while the people are picked. */
export type SavedFace={asset:string;index:number;name?:string;clothes?:string};
/** What the user filled in, so a reload shows the same video, faces and words. */
export type SavedInput={video:string;prompt:string;addPrompt?:boolean;faces?:SavedFace[];target?:string;reference?:string};
/** A step of either chain; a swap step carries the tracker's words too. */
export type ChainStep=ReplaceStep&{tracking?:Record<string,unknown>};

export type ChainRecord={
  version:1;
  /** Names every step's idempotency key, so a step that was queued is reached instead of queued again. */
  requestId:string;
  /** Swap a thing counts presses, so a new press runs new work instead of reaching the old run. */
  attempt:number;
  input:SavedInput;
  /** The chain as it was first built: after a reload it is the same chain, not a rebuilt one. */
  steps:ChainStep[];
  /** The first step with no output yet, or `steps.length` once every step is done. */
  stepIndex:number;
  /** Step id → the run that made it, or is making it. */
  runIds:Record<string,string>;
  /** Step id → the asset that step made. */
  outputs:Record<string,string>;
};

/** The first step without an output, so a step that finished is never queued again. */
function openIndex(steps:ChainStep[],outputs:Record<string,string>):number{
  const index=steps.findIndex(step=>!outputs[step.id]);
  return index<0?steps.length:index;
}

/** A new chain, at its first step. */
export function beginChain(chain:{requestId:string;attempt:number;input:SavedInput;steps:ChainStep[]}):ChainRecord{
  return {version:1,...chain,stepIndex:0,runIds:{},outputs:{}};
}

/** Remember a finished step and move the open step past it. */
export function saveStep(record:ChainRecord,stepId:string,runId:string,output:string):ChainRecord{
  const outputs={...record.outputs,[stepId]:output};
  return {...record,runIds:{...record.runIds,[stepId]:runId},outputs,stepIndex:openIndex(record.steps,outputs)};
}

/** A step that did not finish is tried afresh next time: its run id goes, and the next press names new runs. */
export function failedStep(record:ChainRecord,stepId:string):ChainRecord{
  const runIds={...record.runIds};delete runIds[stepId];
  return {...record,requestId:crypto.randomUUID(),attempt:record.attempt+1,runIds};
}

/** The steps still to run, in order. */
export const openSteps=(record:ChainRecord)=>record.steps.slice(record.stepIndex);

/** A step's inputs, with each earlier step's output in place of its name. */
export function stepInputs(step:Pick<ReplaceStep,"inputs">,outputs:Record<string,string>):Record<string,string>{
  return Object.fromEntries(Object.entries(step.inputs).map(([key,value])=>[key,"asset" in value?value.asset:outputs[value.step]]));
}

const assetIds=(value:unknown):value is Record<string,string>=>!!value&&typeof value==="object"&&Object.values(value as Record<string,unknown>).every(id=>typeof id==="string"&&!!id);

/** A saved chain, or null when the value is not one this panel can pick up. */
export function parseChain(value:unknown):ChainRecord|null{
  const v=value as ChainRecord;
  if(!v||v.version!==1||typeof v.requestId!=="string"||!v.requestId)return null;
  if(!Number.isInteger(v.attempt)||v.attempt<0)return null;
  if(!Array.isArray(v.steps)||!v.steps.length)return null;
  if(!v.steps.every(step=>!!step&&typeof step.id==="string"&&!!step.id&&typeof step.label==="string"&&typeof step.capabilityId==="string"&&typeof step.version==="string"&&!!step.inputs&&!!step.controls))return null;
  const input=v.input;
  if(!input||typeof input.video!=="string"||!input.video||typeof input.prompt!=="string")return null;
  if(input.addPrompt!==undefined&&typeof input.addPrompt!=="boolean")return null;
  if(input.faces!==undefined&&!(Array.isArray(input.faces)&&input.faces.every(face=>!!face&&typeof face.asset==="string"&&!!face.asset&&Number.isInteger(face.index)&&face.index>=0&&(face.name===undefined||typeof face.name==="string")&&(face.clothes===undefined||typeof face.clothes==="string"))))return null;
  if(input.target!==undefined&&typeof input.target!=="string")return null;
  if(input.reference!==undefined&&typeof input.reference!=="string")return null;
  if(v.runIds!==undefined&&!assetIds(v.runIds))return null;
  if(v.outputs!==undefined&&!assetIds(v.outputs))return null;
  if(!Number.isInteger(v.stepIndex)||v.stepIndex<0||v.stepIndex>v.steps.length)return null;
  const outputs=v.outputs??{};
  // The open step follows the outputs that exist, so a step that already finished is never queued again.
  return {version:1,requestId:v.requestId,attempt:v.attempt,input,steps:v.steps,runIds:v.runIds??{},outputs,stepIndex:openIndex(v.steps,outputs)};
}

/** The chain saved for this tool and project, or null when there is none, it does not hold together, or every
 *  step is already done (there is nothing left to pick up). */
export function readChain(storage:ChainStorage|null,key:string):ChainRecord|null{
  try{
    const raw=storage?.getItem(key),record=raw?parseChain(JSON.parse(raw)):null;
    return record&&record.stepIndex<record.steps.length?record:null;
  }catch{return null;}
}

/** Keep the place. Storage that refuses (a private window) loses the resume, never the runs themselves. */
export function saveChain(storage:ChainStorage|null,key:string,record:ChainRecord):void{
  try{storage?.setItem(key,JSON.stringify(record));}catch{/* the runs are on the server */}
}

export function clearChain(storage:ChainStorage|null,key:string):void{
  try{storage?.removeItem(key);}catch{/* nothing was kept */}
}

export type ReplaceChainRun={
  call:Call;workspaceId:string;projectId:string;workerId:string;
  /** The saved chain: the loop starts at its open step and keeps it up to date. */
  record:ChainRecord;storage?:ChainStorage|null;key?:string;
  /** The step now working, or "" when the chain ends. */
  onStep?:(label:string)=>void;
  /** The chain after every step, so the panel shows the open step and a reload finds it. */
  onSaved?:(record:ChainRecord)=>void;
  /** Called after each queue and each check, so panels refresh their lists. */
  onChanged?:()=>void;
  /** How long to wait between checks, and the wait itself (tests pass an instant one). */
  waitMs?:number;sleep?:(ms:number)=>Promise<void>;
  /** False once the panel is closed, so the loop stops without an error. */
  alive?:()=>boolean;
};

const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

/** The run a saved id names, or null when it is gone, so the step is queued again. */
async function queuedRun(call:Call,workspaceId:string,id:string|undefined):Promise<Run|null>{
  if(!id)return null;
  try{return await call<Run>(workspacePath(workspaceId,`runs/${encodeURIComponent(id)}`),"GET");}catch{return null;}
}

/** Queue the steps from the open one, feeding each output into the next, and keep the chain up to date.
 *  A step that was already queued is fetched instead of queued again, so a reload finishes the chain. */
export async function runReplaceChain({call,workspaceId,projectId,workerId,record,storage=null,key,onStep,onSaved,onChanged,waitMs=3000,sleep=wait,alive=()=>true}:ReplaceChainRun):Promise<ChainRecord>{
  let chain=record;
  const keep=(next:ChainRecord)=>{chain=next;if(key!==undefined)saveChain(storage,key,next);onSaved?.(next);};
  try{
    for(const step of openSteps(chain)){
      if(!alive())return chain;
      onStep?.(step.label);
      const inputs=stepInputs(step,chain.outputs);
      let run=await queuedRun(call,workspaceId,chain.runIds[step.id]);
      if(!run)run=await call<Run>(workspacePath(workspaceId,"runs"),"POST",{projectId,workerId,idempotencyKey:`replace-${chain.requestId}-${step.id}`,capabilityId:step.capabilityId,version:step.version,routeId:"local",inputs,elementInputs:{},controls:step.controls,audioPolicy:"mute"});
      onChanged?.();
      while(activeRun(run.state)&&alive()){await sleep(waitMs);run=await call<Run>(workspacePath(workspaceId,`runs/${encodeURIComponent(run.id)}`),"GET");}
      // The panel closed while this step was working: the run is on the server and is fetched next time.
      if(activeRun(run.state))return chain;
      const output=run.output_ids[0];
      if(run.state!=="succeeded"||!output){
        // A run that did not finish is not fetched again: the next press names a new one.
        keep(failedStep(chain,step.id));
        throw new Error(`${step.label}: ${run.error??run.state}. Press Continue to go on from here.`);
      }
      keep(saveStep(chain,step.id,run.id,output));
      onChanged?.();
    }
    return chain;
  }finally{onStep?.("");}
}

/* Enhance video: a few choices instead of one workspace per finishing pack. Each pack that can be a
   step says so in its manifest (`role` with tool "upscale", read through roles.ts, which also accepts
   the older `finishStep`): which row it belongs to (`task`: upscale, interpolate), which option of that
   row it offers, its rank among packs offering the same option and its place in the chain. Nothing here
   names a pack: the ready catalogue decides what the person sees and what runs. */
import type {CapabilityManifestV2,FinishStepRequest} from "./types";
import {finishRoleOf} from "./roles";

type FinishManifest = Pick<CapabilityManifestV2,"id"|"title"|"role"|"finishStep">;
export type FinishOption = {step:string; option:string; label:string; pack:string; fallback:boolean; order:number};
/** The rows of the tool, in chain order, each with its options; only options a ready pack offers. */
export type FinishRow = {step:string; order:number; options:FinishOption[]};
/** What the person picked: step → option. A step left out, or set to "off", does not run. */
export type FinishChoice = Record<string,string|undefined>;
export type PlannedStep = FinishStepRequest & {label:string; step:string; fallback:boolean};

/** The ready packs grouped into rows and options, best-ranked pack per option. */
export function finishRows<T extends FinishManifest>(ready:readonly T[]):FinishRow[]{
  const best=new Map<string,{manifest:T;rank:number;fallback:boolean}>();
  const byOption=new Map<string,T[]>();
  for(const manifest of ready){
    const step=finishRoleOf(manifest);if(!step)continue;
    const key=`${step.task}\u0000${step.option}`;
    byOption.set(key,[...(byOption.get(key)??[]),manifest]);
  }
  const rank=(pack:T)=>finishRoleOf(pack)!.rank;
  for(const [key,packs] of byOption){
    const sorted=[...packs].sort((a,b)=>rank(a)-rank(b));
    best.set(key,{manifest:sorted[0],rank:rank(sorted[0]),fallback:rank(sorted[0])>1});
  }
  const rows=new Map<string,FinishRow>();
  for(const {manifest,fallback} of best.values()){
    const step=finishRoleOf(manifest)!;
    const row=rows.get(step.task)??{step:step.task,order:step.order,options:[]};
    row.options.push({step:step.task,option:step.option,label:step.label,pack:manifest.id,fallback,order:step.order});
    row.order=Math.min(row.order,step.order);
    rows.set(step.task,row);
  }
  /* The option a manifest marks as the default leads its row, so a first visit picks it whatever the catalogue order. */
  const leads=(option:FinishOption)=>byOption.get(`${option.step}\u0000${option.option}`)!.some(pack=>finishRoleOf(pack)!.defaultOption)?0:1;
  for(const row of rows.values())row.options.sort((a,b)=>leads(a)-leads(b));
  return [...rows.values()].sort((a,b)=>a.order-b.order);
}

/** A clip's frame rate from a probe string such as "24/1" or "30000/1001". */
export function frameRateOf(value:unknown):number|undefined{
  if(typeof value==="number")return value>0?value:undefined;
  if(typeof value!=="string")return undefined;
  const [num,den]=value.split("/").map(Number);
  const rate=den?num/den:num;
  return Number.isFinite(rate)&&rate>0?rate:undefined;
}

/** The controls one pack runs with as a step, given the frame rate of the clip it receives. */
export function stepControls(manifest:FinishManifest,sourceFps?:number):Record<string,string|number|boolean>{
  const step=finishRoleOf(manifest)!,controls={...(step.controls??{})};
  if(step.fpsFromSource&&sourceFps){
    const times=Number(controls[step.fpsFromSource.multiplierControl]??1);
    controls[step.fpsFromSource.control]=Math.round(sourceFps*times);
  }
  return controls;
}

/** The chain the choice makes, in run order. Step 1's controls use the source clip's frame rate;
 *  later steps get theirs on the server from the clip the step before made. */
export function planFinish<T extends FinishManifest>(choice:FinishChoice,ready:readonly T[],sourceFps?:number):PlannedStep[]{
  const rows=finishRows(ready);
  const steps:PlannedStep[]=[];
  for(const row of rows){
    const picked=choice[row.step];
    const option=picked&&picked!=="off"?row.options.find(candidate=>candidate.option===picked):undefined;
    if(!option)continue;
    const manifest=ready.find(item=>item.id===option.pack)!;
    steps.push({capabilityId:manifest.id,controls:stepControls(manifest,steps.length?undefined:sourceFps),label:option.label,step:row.step,fallback:option.fallback});
  }
  return steps;
}

/** The chain line under the options, e.g. "FILM 2x, then ReCaVSR 2x". */
export const chainLine=(steps:readonly Pick<PlannedStep,"label">[])=>steps.map(step=>step.label).join(", then ");

/** What a finished chain did, in plain words for a result card ("Upscaled ×2", "Smooth"), one per row
 *  in run order. `stepOf` maps a pack to its row; a pack it does not know is left out. */
export function finishDone(packs:readonly string[]|undefined,stepOf:Record<string,string>|undefined,scale?:number):string[]{
  const rows=[...new Set((packs??[]).map(pack=>stepOf?.[pack]).filter((row):row is string=>!!row))];
  if(!rows.length)return scale&&scale>1?[`Upscaled ×${scale}`]:[];
  return rows.map(row=>row==="upscale"?scale&&scale>1?`Upscaled ×${scale}`:"Upscaled":row==="interpolate"?"Smooth":row);
}
/** Pack → row for every pack that can be an Enhance step. */
export const finishStepsOf=(catalogue:readonly FinishManifest[])=>Object.fromEntries(catalogue.flatMap(m=>{const role=finishRoleOf(m);return role?[[m.id,role.task]]:[];}));

/** A draft workflow whose quality control also offers "normal" lets the person choose its finish (the Finish button in
 *  the panel). A finish pack (the Deno variants) has no "normal": it is the finish. Read from the manifest, not ids. */
export function offersFinishChoice(manifest:{controls:readonly {id:string;options?:readonly unknown[]}[]}):boolean{
  return !!manifest.controls.find(control=>control.id==="quality")?.options?.includes("normal");
}

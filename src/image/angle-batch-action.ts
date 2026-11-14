import type {CapabilityManifestV2} from "../capabilities/types";
import type {ImageDraft} from "./image-state";
import {freezeAngleBatch,type AngleBatch,type AngleScope} from "./angle-batch";

export type AngleBatchActionState={kind:"generate"|"resume"|"extend"|"new";label:string;enabled:boolean;busy:boolean;hint:string};
export type AngleBatchAction=AngleBatchActionState&{invoke:()=>void};
export function angleBatchActionState({batch,selected,manifest,draft,scope,disabled,busy,pending,uncertain}:{batch:AngleBatch|null;selected:string[];manifest:CapabilityManifestV2;draft:ImageDraft;scope:AngleScope;disabled:boolean;busy:boolean;pending:boolean;uncertain:boolean}):AngleBatchActionState{
  const submitted=!!batch&&batch.presetIds.every(id=>!!batch.runIds[id]);
  if(batch&&batch.capabilityVersion!==manifest.version){
    if(batch.pendingPreset)return {kind:"resume",label:"Recover saved request",enabled:!disabled&&!busy,busy:busy||pending,hint:"The recipe changed. Recover only the original request's outcome with its original version and key."};
    const enabled=!busy&&!pending&&!uncertain;
    return {kind:"new",label:"New angle batch",enabled,busy:busy||pending,hint:enabled?"The saved recipe changed. Results remain available until you start a fresh batch with the current recipe.":"Wait for the saved requests to resolve or cancel their active runs."};
  }
  if(submitted){
    const added=selected.filter(id=>!batch.presetIds.includes(id));
    if(added.length){
      const supported=added.every(id=>manifest.presets.some(preset=>preset.id===id));
      const enabled=supported&&!disabled&&!busy&&!pending&&!uncertain&&!batch.pendingPreset;
      return {kind:"extend",label:busy?"Queuing angles":`Generate ${added.length} new ${added.length===1?"angle":"angles"}`,enabled,busy:busy||pending,hint:enabled?"Only the newly selected angles will be added to this batch.":"Wait for the saved requests to resolve before adding angles."};
    }
    const enabled=!busy&&!pending&&!uncertain&&!batch.pendingPreset;
    return {kind:"new",label:"New angle batch",enabled,busy:busy||pending,hint:enabled?"Select another angle to add it, or start a fresh batch with the current source and settings.":"Wait for the saved requests to resolve or cancel their active runs."};
  }
  if(batch)return {kind:"resume",label:busy?"Queuing angles":"Resume saved batch",enabled:!disabled&&!busy,busy:busy||pending,hint:"Resume the frozen source, settings and original request keys."};
  let hint="";
  try{freezeAngleBatch(manifest,draft,selected,scope,"preflight");}catch(error){hint=(error as Error).message;}
  return {kind:"generate",label:busy?"Queuing angles":selected.length?`Generate ${selected.length} ${selected.length===1?"angle":"angles"}`:"Generate angles",enabled:!disabled&&!busy&&!hint,busy,hint:hint||"Each selected angle creates one independent run."};
}

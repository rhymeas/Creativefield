import {z} from "zod";
import type {CapabilityManifestV2} from "../capabilities/types";
import type {ImageDraft} from "./image-state";

export const subjectRelightSchema=z.object({version:z.literal(1),workspaceId:z.uuid(),projectId:z.uuid(),assetId:z.uuid(),prompt:z.string().trim().min(1).max(8000)}).strict();
export const subjectRelightKey=(workspace:string,project:string,asset:string)=>`comfyfield.subject-relight.${workspace}.${project}.${asset}`;
export function subjectRelightInstruction(manifest:CapabilityManifestV2,draft:ImageDraft,direction:string,temperature:string){
  const mood=manifest.presets.find(preset=>preset.id===draft.presetId)?.values.prompt;
  return [typeof mood==="string"?mood:"",String(draft.controls.prompt??"").trim(),`Light direction: ${direction}. Light temperature: ${temperature}.`,"Relight only the selected subject. Preserve its identity, clothing, shape and texture."].filter(Boolean).join("\n\n");
}
export function readSubjectRelight(raw:string|null,scope:{workspaceId:string;projectId:string;assetId:string}){
  try{
    const value=subjectRelightSchema.parse(JSON.parse(raw??"null"));
    return value.workspaceId===scope.workspaceId&&value.projectId===scope.projectId&&value.assetId===scope.assetId?value:null;
  }catch{return null;}
}

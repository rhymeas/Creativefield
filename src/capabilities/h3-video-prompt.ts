import type {ApiGraph} from "../workflow/build";
import type {CapabilityManifestV2} from "./types";
import {shapeH3BasePrompt, type H3BaseAlignment} from "./shot-direction";

/** The H3 video nodes take the prompt their encoder was trained on; wrap a bare user sentence in the
 *  official format, keeping the words verbatim. Reference-to-video packs that already write the six-section
 *  reference format (Make it real) or an embedding token are left alone. */
export function applyH3VideoPrompt(graph:ApiGraph,manifest:CapabilityManifestV2,controls:Record<string,unknown>,audioPolicy:string){
  /* Opt-in until the A/B wins: server-side flag only, never read from a request. */
  if(!(typeof process!=="undefined"&&process.env?.COMFYFIELD_H3_PROMPT_SHAPE==="1"))return;
  const lengthControl=manifest.controls.find(control=>control.id==="length");
  const seconds=Number(controls.length??lengthControl?.default??0);
  const sound=audioPolicy!=="mute";
  for(const node of Object.values(graph)){
    if(typeof node.inputs.prompt!=="string")continue;
    const base=node.class_type==="MiniMaxH3ImageToVideo";
    const reference=node.class_type==="MiniMaxH3ReferenceToVideo";
    if(!base&&!reference)continue;
    const prompt=node.inputs.prompt.trim();
    if(!prompt||/^embedding:/i.test(prompt)||/^integrated_multimodal_description:/m.test(prompt)||/^subject_definitions:/m.test(prompt))continue;
    const first=Array.isArray(node.inputs.first_frame)||(reference&&Object.keys(node.inputs).some(key=>key.startsWith("ref_images.")));
    const last=Array.isArray(node.inputs.last_frame);
    const alignment:H3BaseAlignment=first&&last?"first-last":first?"first":"none";
    node.inputs.prompt=shapeH3BasePrompt(prompt,{alignment,seconds:Number.isFinite(seconds)?seconds:undefined,sound});
  }
}

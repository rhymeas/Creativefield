import type { CapabilityBundle, SourceLinkedMaskSnapshot } from "./types";
import { assertRoutePolicy } from "./policy";
import {assertSecondsDurationGraph,hasQualifiedDurationMapping} from "./timing";
import { validateImageArtifacts } from "./image-artifacts";
import {validatePosePreviewContract} from "./pose-preview";
import { validateImageInputContract } from "./image-input-contract";
import {validateEditPreservation} from "./edit-preservation";
import {optionalReferenceLink} from "./optional-image-references";

/** Runtime validation for trusted, versioned registry bundles. Not a public arbitrary-graph import API. */
export function validateCapability(bundle: CapabilityBundle): string[] {
  const errors: string[] = [];
  const m = bundle.manifest;
  if (!m || m.schemaVersion !== 2 || !/^[a-z0-9][a-z0-9._-]*$/.test(m.id) || !m.version) return ["Invalid manifest identity or schema version"];
  if (!Array.isArray(m.inputs) || !Array.isArray(m.outputs) || !Array.isArray(m.controls) || !Array.isArray(m.routes)) return ["Missing port, control or route lists"];
  const ids = new Set<string>();
  if(m.mediaContract){
    const contract=m.mediaContract,source=m.inputs.find(p=>p.id===contract.sourceInput),mask=m.inputs.find(p=>p.id===contract.maskInput);
    if(contract.kind!=="aligned_video_mask_v1"||!source?.required||source.type!=="video"||!mask?.required||mask.type!=="mask"||mask.representation!=="video"||m.audioPolicies.length!==1||m.audioPolicies[0]!=="mute")errors.push("Invalid aligned video/mask contract");
    if(contract.additionalMaskInputs!==undefined){
      const additional=contract.additionalMaskInputs;
      if(!Array.isArray(additional)||additional.length<1||additional.length>3||new Set([contract.sourceInput,contract.maskInput,...additional]).size!==additional.length+2||additional.some(id=>{const port=m.inputs.find(p=>p.id===id);return !port?.required||port.type!=="mask"||port.representation!=="video";}))errors.push("Invalid additional aligned mask inputs");
    }
  }
  if(m.outputContract){
    const contract=m.outputContract,source=m.inputs.find(p=>p.id===contract.sourceInput),mask=m.outputs.find(p=>p.id===contract.maskOutput);
    if(contract.kind!=="source_linked_mask_v1"||contract.semantics!=="white_edits_black_preserves"||!source?.required||source.type!=="video"||!mask?.required||mask.type!=="mask"||mask.representation!=="video"||m.audioPolicies.length!==1||m.audioPolicies[0]!=="mute"||m.timing?.fps!==16||!m.timing.sourceTimed)errors.push("Invalid source-linked mask output contract");
    if(contract.trackingMode!==undefined&&contract.trackingMode!=="points"&&contract.trackingMode!=="prompt")errors.push("Invalid source-linked mask tracking mode");
    if(contract.trackingMode==="prompt"){
      const prompt=m.controls.find(control=>control.id==="prompt");
      if(!prompt||prompt.binding?.field!=="text"||!bundle.template||bundle.template[prompt.binding.node]?.class_type!=="CLIPTextEncode")errors.push("Invalid prompt tracking control");
    }
    if(!bundle.template||bundle.template[contract.artifactNode]?.class_type!=="SaveVideo")errors.push("Invalid source-linked mask artifact node");
    const checkpoints=m.routes.map(route=>route.requirements.find(r=>r.id===contract.checkpointRequirementId)).filter(Boolean);
    if(!checkpoints.length||checkpoints.some(req=>req?.kind!=="model"||!/^sha256:[a-f0-9]{64}$/.test(req.version??"")))errors.push("Invalid source-linked mask checkpoint requirement");
  }
  if(m.fpsPrepare){
    const contract=m.fpsPrepare,source=m.inputs.find(p=>p.id===contract.sourceInput);
    if(contract.kind!=="source_16fps_v1"||!source?.required||source.type!=="video"||m.audioPolicies.some(policy=>policy!=="mute"))errors.push("Invalid 16 fps prepare contract");
  }
  if(m.voiceContract){
    const c=m.voiceContract,audio=m.inputs.find(p=>p.id===c.audioInput);
    if(c.kind!=="wan_infinitetalk_v1"||!audio?.required||audio.type!=="audio"||m.timing?.fps!==25||m.timing.maxSeconds>3.2||!m.audioPolicies.includes("replace")||m.audioPolicies.some(p=>p!=="replace"&&p!=="mute"))errors.push("Invalid single-speaker voice contract");
    if(bundle.template?.[c.trimNode]?.class_type!=="TrimAudioDuration"||bundle.template?.[c.artifactNode]?.class_type!=="SaveVideo")errors.push("Invalid voice trim/artifact node");
    if(!m.controls.some(control=>control.id==="length"&&control.binding?.transform==="seconds_to_wan_frames"))errors.push("Voice duration needs a frame binding");
    const graph=bundle.template??{},link=(value:unknown,node:string)=>Array.isArray(value)&&value.length===2&&value[0]===node&&value[1]===0;
    const audioNode=audio?.binding?.node??"",encoder=Object.entries(graph).find(([,n])=>n.class_type==="AudioEncoderEncode"),video=Object.entries(graph).find(([,n])=>n.class_type==="CreateVideo"),length=m.controls.find(control=>control.id==="length"),performance=graph[length?.binding?.node??""];
    if(graph[audioNode]?.class_type!=="LoadAudio"||!link(graph[c.trimNode]?.inputs.audio,audioNode)||!encoder||!link(encoder[1].inputs.audio,c.trimNode)||!video||!link(video[1].inputs.audio,c.trimNode)||video[1].inputs.fps!==25||!link(graph[c.artifactNode]?.inputs.video,video[0]))errors.push("Voice audio must use the same bounded window for encoding and output");
    if(performance?.class_type!=="WanInfiniteTalkToVideo"||performance.inputs.mode!=="single_speaker"||!encoder||!link(performance.inputs.audio_encoder_output_1,encoder[0])||!m.controls.some(control=>control.id==="audio_start"&&control.binding?.node===c.trimNode&&control.binding.field==="start_index"))errors.push("Invalid single-speaker performance binding");
  }
  if(m.motionContract){
    const contract=m.motionContract,port=m.inputs.find(p=>p.id===contract.motionInput),out=m.outputs.find(p=>p.required&&p.type==="video");
    if(contract.kind!=="wan_animate_motion_v1"||contract.fps!==24||!port?.required||port.type!=="video"||!out||m.audioPolicies.length!==1||m.audioPolicies[0]!=="mute")errors.push("Invalid Wan Animate motion contract");
    if(!bundle.template||bundle.template[contract.artifactNode]?.class_type!=="SaveVideo")errors.push("Invalid Wan Animate motion artifact node");
  }
  if (m.imageArtifacts) errors.push(...validateImageArtifacts(m.imageArtifacts, m, bundle.template));
  errors.push(...validatePosePreviewContract(bundle));
  if (m.imageInputContract) errors.push(...validateImageInputContract(m.imageInputContract, m));
  if (m.editPreservation) errors.push(...validateEditPreservation(bundle));
  if(m.subjectContract){
    const prompt=m.controls.find(control=>control.id==="prompt");
    if(m.subjectContract.kind!=="keep_source_subject_v1")errors.push("Invalid keep-subject prompt contract");
    if(!prompt||prompt.disabledReason||prompt.binding?.field!=="text"||bundle.template?.[prompt.binding.node]?.class_type!=="CLIPTextEncode")errors.push("Invalid keep-subject prompt control");
  }
  if(m.timing?.frameMapping){
    if(!hasQualifiedDurationMapping(m))errors.push("Invalid duration mapping");
    else if(m.timing.frameMapping==="wan_seconds_floor_4n1"){
      try{if(!bundle.template)throw new Error("Missing timing graph");assertSecondsDurationGraph(bundle.template,m.controls.find(c=>c.id==="length")!.binding!,m.timing.fps);}catch(e){errors.push(String(e));}
    }
  }
  for (const item of [...m.inputs, ...m.controls]) {
    if (!item.id || ids.has(item.id)) errors.push(`Duplicate or empty input/control: ${item.id}`);
    ids.add(item.id);
    if (item.binding && (!bundle.template?.[item.binding.node] || !(item.binding.field in bundle.template[item.binding.node].inputs))) errors.push(`Invalid binding: ${item.id}`);
  }
  const routes = new Set<string>();
  for(const port of m.inputs.filter(port=>port.omitWhenMissing)){
    try{optionalReferenceLink(bundle.template??{},port);}catch(error){errors.push((error as Error).message);}
  }
  for (const route of m.routes) {
    if (routes.has(route.id)) errors.push(`Duplicate route: ${route.id}`);
    routes.add(route.id);
    try { assertRoutePolicy(route); } catch (e) { errors.push(String(e)); }
    if (route.implementation === "implemented" && (route.execution === "local_comfy" || route.execution === "comfy_cloud") && !bundle.template) errors.push("Implemented route has no workflow");
  }
  for (const c of m.controls) {
    if (!c.disabledReason && !c.binding && !c.apiField) errors.push(`Enabled control is unbound: ${c.id}`);
    if (c.min !== undefined && c.max !== undefined && c.min > c.max) errors.push(`Invalid range: ${c.id}`);
  }
  for (const preset of m.presets) for (const id of Object.keys(preset.values)) {
    if (!m.controls.some(c => c.id === id && !c.disabledReason)) errors.push(`Preset ${preset.id} targets unknown/disabled control: ${id}`);
  }
  return errors;
}

export type SourceLinkedMaskExpectation = Omit<SourceLinkedMaskSnapshot,"validationVersion"|"contract"|"maskSha256"|"semantics">;

/** Validates a server-created tracking receipt against the frozen source/run intent.
 * This is intentionally separate from aligned_video_mask_v1, which validates an
 * already-published source and mask pair at edit admission. */
export function validateSourceLinkedMaskSnapshot(value:unknown,expected:SourceLinkedMaskExpectation):value is SourceLinkedMaskSnapshot {
  if(!value||typeof value!=="object")return false;
  const v=value as Record<string,unknown>;
  if(v.validationVersion!==1||v.contract!=="source_linked_mask_v1"||v.semantics!=="white_edits_black_preserves")return false;
  if(typeof v.maskSha256!=="string"||!/^[a-f0-9]{64}$/.test(v.maskSha256))return false;
  return (Object.keys(expected) as Array<keyof SourceLinkedMaskExpectation>).every(key=>v[key]===expected[key]);
}

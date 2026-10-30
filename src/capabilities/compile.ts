import { secondsToWanFrames, type ApiGraph } from "../workflow/build";
import type { CapabilityBundle, Invocation } from "./types";
import { assertCloudGraphPolicy, assertLocalGraphPolicy, assertRoutePolicy } from "./policy";
import {omitMissingReferences} from "./optional-image-references";
import {keepSourceSubjectPrompt} from "./keep-subject";

/** Compiles only server-owned templates. Asset filenames must have been resolved by
 * the server after workspace ownership checks, never supplied as browser paths. */
export function compileLocal(bundle: CapabilityBundle, invocation: Invocation,options:{allowExperimental?:boolean}={}): ApiGraph {
  const { manifest, template } = bundle;
  if (invocation.capabilityId !== manifest.id || invocation.version !== manifest.version) throw new Error("Capability revision mismatch");
  const route = manifest.routes.find(r => r.id === invocation.routeId);
  const allowed=route?.implementation==="implemented"||(options.allowExperimental&&route?.implementation==="experimental");
  /* A cloud route compiles the same template; only where the graph runs differs. */
  const cloud = route?.execution === "comfy_cloud";
  if (!route || (route.execution !== "local_comfy" && !cloud) || !allowed || !template) throw new Error("Selected route is unavailable");
  const graphPolicy = cloud ? assertCloudGraphPolicy : assertLocalGraphPolicy;
  assertRoutePolicy(route); graphPolicy(template);
  const silentImageOperation=manifest.imageArtifacts&&manifest.audioPolicies.length===0&&invocation.audioPolicy==="mute";
  if (!silentImageOperation&&!manifest.audioPolicies.includes(invocation.audioPolicy)) throw new Error("Audio policy is not supported by this workflow");
  if (manifest.resolutions) {
    const width = invocation.controls.width ?? manifest.controls.find(c => c.id === "width")?.default;
    const height = invocation.controls.height ?? manifest.controls.find(c => c.id === "height")?.default;
    if (!Object.values(manifest.resolutions).some(r => r.width === width && r.height === height)) throw new Error("Unsupported resolution pair");
  }
  const graph = structuredClone(template);
  const preset=invocation.presetId?manifest.presets.find(p=>p.id===invocation.presetId):undefined;
  if(invocation.presetId&&!preset)throw new Error("Selected preset is not part of this workflow");
  const values={...invocation.controls};
  for(const [id,presetValue] of Object.entries(preset?.values??{})){
    const control=manifest.controls.find(c=>c.id===id&&!c.disabledReason);
    if(!control)throw new Error(`Preset targets unknown control: ${id}`);
    if(id==="prompt"&&typeof presetValue==="string"){
      const note=typeof values.prompt==="string"?values.prompt.trim():"";
      values.prompt=note?`${presetValue}\n\n${note}`:presetValue;
    }else if(values[id]===undefined||values[id]===control.default)values[id]=presetValue;
  }
  for (const id of Object.keys(invocation.controls)) if (!manifest.controls.some(c => c.id === id)) throw new Error(`Unknown control: ${id}`);
  for (const id of Object.keys(invocation.inputs)) if (!manifest.inputs.some(p => p.id === id)) throw new Error(`Unknown input: ${id}`);
  // A prepared 16 fps copy reaches the graph in place of the upload. Its receipt must
  // describe the one envelope the restyle and tracking graphs can hold.
  if (manifest.fpsPrepare && invocation.fpsPrepare) {
    const prepared = invocation.fpsPrepare;
    if (prepared.contract !== "source_16fps_v1" || prepared.fps !== 16 || prepared.frames < 17 || prepared.frames > 81 || (prepared.frames - 1) % 4 !== 0)
      throw new Error("Prepared source envelope is invalid");
  }
  omitMissingReferences(graph,manifest.inputs,invocation.inputs);
  for (const port of manifest.inputs) {
    const file = invocation.inputs[port.id];
    if (!file && port.required) throw new Error(`Missing asset: ${port.id}`);
    if (file) {
      if (typeof file !== "string" || !/^comfyfield-[a-zA-Z0-9_.-]+$/.test(file)) throw new Error("Assets must be resolved by the server");
      if (!port.binding || !graph[port.binding.node] || !(port.binding.field in graph[port.binding.node].inputs)) throw new Error(`Missing input binding: ${port.id}`);
      graph[port.binding.node].inputs[port.binding.field] = file;
    }
  }
  for (const control of manifest.controls) {
    if (control.disabledReason) {
      if (control.id in invocation.controls) throw new Error(control.disabledReason);
      continue;
    }
    const binding = control.binding;
    if (!binding || !graph[binding.node] || !(binding.field in graph[binding.node].inputs)) throw new Error(`Unbound control: ${control.id}`);
    let value = values[control.id] ?? control.default;
    if (control.type === "string" && (typeof value !== "string" || value.length > 20000)) throw new Error(`Invalid text: ${control.id}`);
    if (control.type === "boolean" && typeof value !== "boolean") throw new Error(`Invalid boolean: ${control.id}`);
    if (["number", "integer"].includes(control.type)) {
      if (typeof value !== "number" || !Number.isFinite(value) || (control.type === "integer" && !Number.isSafeInteger(value))) throw new Error(`Invalid number: ${control.id}`);
      if ((control.min !== undefined && value < control.min) || (control.max !== undefined && value > control.max)) throw new Error(`Out of range: ${control.id}`);
    }
    if (control.type === "select" && !control.options?.includes(value as string | number)) throw new Error(`Unsupported option: ${control.id}`);
    if (binding.transform === "seconds_to_wan_frames") value = secondsToWanFrames(Number(value), manifest.timing!.fps);
    if (binding.transform === "divide_native_scale") value = Number(value) / manifest.nativeScale!;
    if (!manifest.mediaContract && (control.id === "negative" || control.id === "motion_prompt") && typeof value === "string" && !value.trim()) continue;
    graph[binding.node].inputs[binding.field] = value;
  }
  /* The words are read after presets and defaults, because the look, the note and the clause meet there. */
  const promptControl = manifest.controls.find(c => c.id === "prompt" && !c.disabledReason);
  if (manifest.subjectContract?.kind === "keep_source_subject_v1" && promptControl?.binding) {
    const binding = promptControl.binding, text = graph[binding.node].inputs[binding.field];
    if (typeof text === "string") graph[binding.node].inputs[binding.field] = keepSourceSubjectPrompt(text);
  }
  if(manifest.voiceContract){
    const frames=secondsToWanFrames(Number(values.length??manifest.controls.find(c=>c.id==="length")?.default),manifest.timing!.fps);
    graph[manifest.voiceContract.trimNode].inputs.duration=frames/manifest.timing!.fps;
  }
  if (invocation.audioPolicy === "mute") for (const node of Object.values(graph)) {
    if (node.class_type === "CreateVideo") delete node.inputs.audio;
  }
  graphPolicy(graph);
  return graph;
}

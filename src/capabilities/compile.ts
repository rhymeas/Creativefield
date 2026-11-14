import { secondsToWanFrames, type ApiGraph } from "../workflow/build";
import type { CapabilityBundle, Invocation } from "./types";
import { assertCloudGraphPolicy, assertLocalGraphPolicy, assertRoutePolicy, localWorkflowClasses } from "./policy";
import {buildHyperflowFirstLastFinish, buildHyperflowQuality, selectHyperflowTextFinish, type HyperflowQuality} from "./hyperflow-quality";
import {h3Frames} from "./timing";
import {omitMissingReferences} from "./optional-image-references";
import {applyH3PictureMentions,applyH3LargeCanvas,applyH3SourceSize} from "./h3-image-mentions";
import {applyFluxEditCanvas} from "./flux-edit-size";
import {applyEditCanvas} from "./edit-size";
import {applyH3VideoPrompt} from "./h3-video-prompt";
import {keepSourceSubjectPrompt} from "./keep-subject";
import {isOpenJutsuAdvanced,OPENJUTSU_SCENE_GUIDE,openJutsuRoles,prepareOpenJutsuAdvancedCharacters} from "./openjutsu-advanced";
import {addOpenJutsuUserInstruction,experimentalOpenJutsuRoles} from "./openjutsu-user-instruction";
import {addOpenJutsuSceneGuide} from "./openjutsu-scene-guide";

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
  const graphPolicy = cloud ? assertCloudGraphPolicy : (graph: ApiGraph) => assertLocalGraphPolicy(graph, localWorkflowClasses(manifest.id));
  assertRoutePolicy(route); graphPolicy(template);
  const silentImageOperation=manifest.imageArtifacts&&manifest.audioPolicies.length===0&&invocation.audioPolicy==="mute";
  if (!silentImageOperation&&!manifest.audioPolicies.includes(invocation.audioPolicy)) throw new Error("Audio policy is not supported by this workflow");
  if (manifest.resolutions) {
    const width = invocation.controls.width ?? manifest.controls.find(c => c.id === "width")?.default;
    const height = invocation.controls.height ?? manifest.controls.find(c => c.id === "height")?.default;
    if (!Object.values(manifest.resolutions).some(r => r.width === width && r.height === height)) throw new Error("Unsupported resolution pair");
  }
  let graph = structuredClone(template);
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
    // Consumed by the client (one run per image); only validated here.
    if (control.runCount) {
      const count = values[control.id] ?? control.default;
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < (control.min ?? 1) || count > (control.max ?? 1)) throw new Error(`Out of range: ${control.id}`);
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
    for (const also of control.alsoBindings ?? []) {
      if (!graph[also.node] || !(also.field in graph[also.node].inputs)) throw new Error(`Unbound control: ${control.id}`);
      graph[also.node].inputs[also.field] = value;
    }
  }
  applyFluxEditCanvas(graph, values, manifest.controls, invocation.sourceSize);
  applyEditCanvas(graph, values, manifest.controls, invocation.sourceSize);
  applyH3PictureMentions(graph, manifest.inputs, invocation.inputs);
  applyH3LargeCanvas(graph);
  applyH3SourceSize(graph, values, manifest.controls, invocation.sourceSize);
  if (manifest.id === "flux2-klein-edit") {
    const refs = ["reference_image", "reference_image_2", "reference_image_3"].map((port,i) => ({file:invocation.inputs[port],id:`cf-ref-${i+1}`})).filter(ref=>!!ref.file);
    // Slots in the UI can have gaps; the model receives the attached images
    // packed after the source, so keep explicit mentions aligned to that order.
    const imageNumbers=new Map<number,number>([[1,1]]);
    for(let i=0;i<refs.length;i++) imageNumbers.set(Number(refs[i].id.slice(-1))+1,i+2);
    graph["28"].inputs.value=String(graph["28"].inputs.value).replace(/@Image\s*(\d{1,2})\b/gi,(match,number:string)=>{
      const position=imageNumbers.get(Number(number));
      return position===undefined?match:`image ${position}`;
    });
    for (let i=1;i<=3;i++) if (!refs.some(ref=>ref.id===`cf-ref-${i}`)) delete graph[`cf-ref-${i}`];
    for (let i=0;i<3;i++) {
      const id=refs[i]?.id;
      if (refs[i]) {
        graph["128:136"].inputs[`images.image${i+1}`]=[id!,0];
        graph["127:146"].inputs[`images.image${i+1}`]=[id!,0];
      }
    }
  }
  if (manifest.id === "hyperflow-h3-flash-i2v") {
    // Autogrow packs connected images in order. Keep explicit picture numbers
    // aligned when a user removes a reference from the middle of the tray.
    const slots = ["reference_image", "reference_image_2", "reference_image_3"];
    const positions = new Map<number,number>([[1,1]]);
    let next = 2;
    for (let i = 0; i < slots.length; i++) if (invocation.inputs[slots[i]]) positions.set(i + 2, next++);
    let prompt = String(graph["5"].inputs.prompt).replace(/<Picture\s+(\d+)>/gi, (match, number: string) => {
      const position = positions.get(Number(number));
      return position === undefined ? match : `<Picture ${position}>`;
    });
    if (next > 2) {
      const references = Array.from({length:next-2}, (_, index) => `<Picture ${index+2}>`).join(", ");
      prompt += `\n\nReference roles: <Picture 1> is the primary scene and composition. ${references} are supplementary references for the changes requested above, not replacement scenes. Follow the user's explicit instructions when they request a scene or composition change.`;
    }
    graph["5"].inputs.prompt = prompt;
  }
  if (isOpenJutsuAdvanced(manifest.id)) {
    const ports = ["reference_image", "reference_image_2", "reference_image_3", "reference_image_4"];
    const filenames: string[] = [];
    let missing = false;
    for (const port of ports) {
      const filename = invocation.inputs[port];
      if (!filename) { missing = true; continue; }
      if (missing) throw new Error("Fill character references in order without empty slots.");
      filenames.push(filename);
    }
    const userText = String(values.prompt ?? values.roles ?? "");
    const roles = manifest.id === "openjutsu-h3-advanced-hyperflow"
      ? experimentalOpenJutsuRoles(userText,filenames.length)
      : openJutsuRoles(userText,filenames.length);
    while (roles.length && !roles[roles.length - 1].trim()) roles.pop();
    graph = prepareOpenJutsuAdvancedCharacters(graph, filenames, roles);
    if (manifest.id === "openjutsu-h3-advanced-hyperflow") {
      graph = addOpenJutsuUserInstruction(graph, userText, filenames.length);
      if (invocation.inputs[OPENJUTSU_SCENE_GUIDE]) addOpenJutsuSceneGuide(graph, filenames.length);
    }
  }
  /* The words are read after presets and defaults, because the look, the note and the clause meet there. */
  const promptControl = manifest.controls.find(c => c.id === "prompt" && !c.disabledReason);
  if (manifest.subjectContract?.kind === "keep_source_subject_v1" && promptControl?.binding) {
    const binding = promptControl.binding, text = graph[binding.node].inputs[binding.field];
    if (typeof text === "string") graph[binding.node].inputs[binding.field] = keepSourceSubjectPrompt(text);
  }
  if (["hyperflow-h3-flash-t2v", "hyperflow-h3-flash-t2v-deno", "hyperflow-h3-flash-flf2v", "hyperflow-h3-flash-flf2v-deno"].includes(manifest.id)) {
    graph["5"].inputs.length = h3Frames(Number(graph["5"].inputs.length), 24);
  }
  if(manifest.id === "hyperflow-h3-flash-t2v" && (values.quality ?? "normal")!=="normal") throw new Error("Upscale requires the HyperFlow Deno workflow");
  if(manifest.id === "hyperflow-h3-flash-t2v-deno") graph=selectHyperflowTextFinish(graph,values.quality==="hd-upscale"?"hd-upscale":"upscale");
  if(manifest.id === "hyperflow-h3-flash-flf2v-deno") graph=buildHyperflowFirstLastFinish(graph,String(values.quality ?? "hd-upscale") as "upscale"|"hd-upscale");
  if (manifest.id === "hyperflow-h3-flash-i2v" || manifest.id === "h3-effects-hyperflow") {
    graph = buildHyperflowQuality(graph, {
      quality: String(values.quality ?? "upscale") as HyperflowQuality,
      image: invocation.inputs.start_image,
      endImage: manifest.id === "hyperflow-h3-flash-i2v" ? invocation.inputs.end_image : undefined,
      prompt: String(graph["5"].inputs.prompt),
      seed: Number(graph["8"].inputs.noise_seed),
      width: Number(graph["5"].inputs.width),
      height: Number(graph["5"].inputs.height),
      seconds: Number(graph["5"].inputs.length),
    });
  }
  if(manifest.voiceContract){
    const frames=secondsToWanFrames(Number(values.length??manifest.controls.find(c=>c.id==="length")?.default),manifest.timing!.fps);
    graph[manifest.voiceContract.trimNode].inputs.duration=frames/manifest.timing!.fps;
  }
  if (invocation.audioPolicy === "mute") for (const node of Object.values(graph)) {
    if (node.class_type === "CreateVideo") delete node.inputs.audio;
  }
  /* Prompt shaping runs last: the HyperFlow packs rebuild their graph and their prompt after the template step. */
  applyH3VideoPrompt(graph, manifest, values, invocation.audioPolicy);
  graphPolicy(graph);
  return graph;
}

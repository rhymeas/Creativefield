import type { ApiGraph } from "../workflow/build";
import type { EnhanceManifest, Manifest } from "../workflow/manifest";
import type { Binding, CapabilityBundle, Control, Port } from "./types";
import { assertLocalGraphPolicy } from "./policy";
import { assertSecondsDurationGraph } from "./timing";

export function fromLegacy(manifest: Manifest | EnhanceManifest, template: ApiGraph, pipeline: string): CapabilityBundle {
  if (manifest.execution?.route !== "native-comfy") throw new Error("Legacy compatibility accepts declared local workflows only");
  assertLocalGraphPolicy(template);
  const enhance = "kind" in manifest;
  if(!enhance && manifest.timing){
    if(manifest.timing.frameMapping!=="wan_seconds_floor_4n1" || !manifest.inputs.length?.node) throw new Error("Invalid legacy timing declaration");
    assertSecondsDurationGraph(template,{node:manifest.inputs.length.node,field:manifest.inputs.length.field,transform:manifest.inputs.length.map},manifest.limits.fps,manifest.outputs.video.node ?? undefined);
  }
  const inputs: Port[] = [];
  const controls: Control[] = [];
  for (const [id, source] of Object.entries(manifest.inputs)) {
    if (!source || !source.node || !(source.field in (template[source.node]?.inputs ?? {}))) throw new Error(`Invalid legacy binding: ${id}`);
    const binding: Binding = { node: source.node, field: source.field, ...(source.map ? { transform: source.map } : {}) };
    const label = id.replaceAll("_", " ");
    if (["start_image", "end_image", "motion_video", "source_video"].includes(id)) {
      inputs.push({ id, label, type: id.includes("video") ? "video" : "image", required: true, binding });
    } else {
      const numeric = ["width", "height", "length", "seed", "scale"].includes(id);
      const control: Control = { id, label, type: numeric ? "integer" : "string", default: template[source.node].inputs[source.field], binding, meaning: "parameter" };
      if (id === "seed") { control.min = 0; control.max = Number.MAX_SAFE_INTEGER; }
      if (id === "width" || id === "height") { control.min = 16; control.max = 4096; }
      if (id === "length" && !enhance) {
        control.type = "number"; control.min = manifest.limits.minDurationSec; control.max = manifest.limits.maxDurationSec;
        control.default = control.min;
      }
      if (id === "scale" && enhance) {
        control.type = "select"; control.options = manifest.factors; control.default = manifest.factors[0];
        binding.transform = "divide_native_scale";
      }
      controls.push(control);
    }
  }
  if(!enhance){
    const width=controls.find(c=>c.id==="width"),height=controls.find(c=>c.id==="height");
    const sizes=Object.values(manifest.limits.resolutions);
    if(width&&height&&!sizes.some(s=>s.width===width.default&&s.height===height.default)){
      width.default=sizes[0].width;height.default=sizes[0].height;
    }
  }
  const motion=pipeline==="motion"&&inputs.some(p=>p.id==="motion_video");
  // The motion template bakes one example character and one example action into
  // its prompt nodes. Those are examples, not defaults for the next run: an
  // empty prompt makes the workspace ask for this character and this take.
  if(motion)for(const control of controls)if(control.id==="prompt"||control.id==="motion_prompt")control.default="";
  const nodes = [...new Set(Object.values(template).map(n => n.class_type))];
  const models = manifest.requires?.models ?? [];
  /* A pipeline pack that needs no local measurement of the clip runs on Comfy Cloud too: the same
     graph, its inputs uploaded as Cloud assets. The motion pipeline is not one of these, because its
     driving clip is normalized by this server before it compiles. Readiness checks the probed cloud's
     own nodes and model files, so a pack Cloud lacks reads its reason instead of running there. */
  const requirements = [
    ...nodes.map(name => ({ id: `node:${name}`, kind: "node" as const, name, instructions: `Install or update the ComfyUI node ${name}.` })),
    ...models.map(m => ({ id: `model:${m.folder}/${m.file}`, kind: "model" as const, name: m.file, location: m.folder, instructions: `Install the licensed model in ComfyUI/models/${m.folder}/${m.file}.` })),
  ];
  const cloud = motion ? [] : [{
    id: "cloud", execution: "comfy_cloud" as const, provider: "comfy-cloud", upstreamProviders: [], implementation: "implemented" as const,
    workflowId: manifest.id, endpointOrigin: "https://cloud.comfy.org",
    requirements: requirements.map(item => ({ ...item, instructions: item.kind === "model" ? `Comfy Cloud carries ${item.name}.` : `Comfy Cloud needs the ComfyUI node ${item.name}.` })),
    evidence: ["2026-10-27: every node and model file this graph names is in Comfy Cloud's own node list (GET /api/object_info). Nothing was run on Comfy Cloud here: that spends credits."],
  }];
  // The motion pipeline is the Wan Animate transfer route: its driving video is
  // normalized to silent 24-CFR media before submission, so the honest audio
  // policy is mute only and the sole SaveVideo node (246) pins the artifact.
  return {
    template,
    manifest: {
      schemaVersion: 2, id: manifest.id, version: "1.0.0", title: manifest.label, category: pipeline,
      description: manifest.display.subtitle, inputs, outputs: [{ id: "video", label: "Video", type: "video", required: true }],
      controls, presets: [], coverage: { local: "implemented", hosted: cloud.length ? "implemented" : "planned" },
      audioPolicies: motion ? ["mute"] : Object.values(template).some(n => n.class_type === "CreateVideo" && "audio" in n.inputs) ? ["preserve", "mute"] : ["mute"],
      ...(motion ? { motionContract: { kind: "wan_animate_motion_v1" as const, motionInput: "motion_video", artifactNode: "246", fps: 24 as const } } : {}),
      routes: [{ id: "local", execution: "local_comfy", provider: "comfy-local", upstreamProviders: [], implementation: "implemented", workflowId: manifest.id,
        requirements,
        evidence: [motion ? "GPU-qualified 2026-10-18 on ComfyUI 0.37.0 / RTX 4090: exact template graph produced 81 frames at 480x848, 24 fps (prompt 74aff839-b45d-4518-aae4-950034a8f362, 205.8 s). Output is 480x848, not the nominal 482x854 resize request, because latent dimensions round to multiples of 16. Perceptual motion quality on real footage is not proven. Transform motion matrix 2026-10-24: four fictional characters (navy jacket, saved green-jacket Element, red dress, blonde in a 16:9 loft) performed the same 49-frame wave; identity, wardrobe and backgrounds held, with a small subject-scale drift on the two non-studio sets." : "Existing versioned local template; current runtime readiness must be checked separately."] }, ...cloud],
      licenses: { software: "Review project and node licenses before distribution", weights: models.map(m => ({ name: m.file, license: "Requires verification" })) },
      sources: [], tickets: ["ARC-01", enhance ? "FIN-04" : pipeline === "motion" ? "EDT-04" : "VID-01"],
      ...(!enhance ? { resolutions: structuredClone(manifest.limits.resolutions), timing: { fps: manifest.limits.fps, minSeconds: manifest.limits.minDurationSec, maxSeconds: manifest.limits.maxDurationSec, sourceTimed: !manifest.inputs.length, ...manifest.timing } } : { nativeScale: manifest.nativeScale }),
    },
  };
}

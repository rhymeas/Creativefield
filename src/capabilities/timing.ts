import {secondsToWanFrames, type ApiGraph} from "../workflow/build";
import type {Binding, CapabilityManifestV2} from "./types";

type FrameMapping = NonNullable<CapabilityManifestV2["timing"]>["frameMapping"];

/** Older pinned manifests express the round mapping directly on the length binding. */
export function durationMapping(m: CapabilityManifestV2): FrameMapping {
  const timing=m.timing, length=m.controls.find(c=>c.id==="length");
  if(!timing || timing.sourceTimed || !Number.isFinite(timing.fps) || timing.fps<=0 || !length?.binding || length.disabledReason) return undefined;
  const declared=timing.frameMapping;
  if(length.binding.transform==="seconds_to_wan_frames") return !declared || declared==="wan_frames_round_4n1" ? "wan_frames_round_4n1" : undefined;
  return !length.binding.transform && (declared==="wan_seconds_floor_4n1"||declared==="h3_seconds_17n5"||declared==="hyperflow_seconds_17n5") ? declared : undefined;
}

export const hasQualifiedDurationMapping = (m: CapabilityManifestV2) => durationMapping(m)!==undefined;

export function expectedGenerationFrames(m: CapabilityManifestV2, seconds: number): number {
  const mapping=durationMapping(m);
  if(!mapping) throw new Error("No qualified frame-duration binding");
  const fps=m.timing!.fps;
  if(mapping==="wan_frames_round_4n1") return secondsToWanFrames(seconds,fps);
  if(mapping==="h3_seconds_17n5"||mapping==="hyperflow_seconds_17n5") return h3Frames(seconds,fps);
  const requested=Math.floor(seconds*fps+1);
  // WanImageToVideo allocates floor((length-1)/4)+1 latent frames; Wan VAE decodes 4*t-3.
  return 4*Math.floor((requested-1)/4)+1;
}

/** The official MiniMax H3 templates: max(5, round(a*fps)) + (5 - (that % 17)) % 17, with Python's modulo.
 *  H3 decodes 5 + 17k frames, so a length rounds up to the next such count. */
export function h3Frames(seconds: number, fps: number): number {
  const f=Math.max(5,Math.round(seconds*fps));
  return f+(((5-f%17)%17)+17)%17;
}

/** Fail closed: the length control must feed the official H3 seconds expression and an H3 video node. */
export function assertH3SecondsGraph(graph: ApiGraph, binding: Binding, fps: number): void {
  const fail=():never=>{throw new Error("Invalid H3 timing binding: not the official seconds expression");};
  if(binding.transform||binding.field!=="value"||graph[binding.node]?.class_type!=="PrimitiveFloat")fail();
  const want=`max(5,round(a*${fps}))+(5-(max(5,round(a*${fps}))%17))%17`;
  const exprs=Object.entries(graph).filter(([,n])=>n.class_type==="ComfyMathExpression"&&Array.isArray(n.inputs["values.a"])&&(n.inputs["values.a"] as unknown[])[0]===binding.node);
  if(exprs.length!==1||String(exprs[0][1].inputs.expression).replace(/\s/g,"")!==want)fail();
  const users=Object.values(graph).filter(n=>(n.class_type==="MiniMaxH3ImageToVideo"||n.class_type==="MiniMaxH3ReferenceToVideo")&&Array.isArray(n.inputs.length)&&(n.inputs.length as unknown[])[0]===exprs[0][0]);
  if(users.length!==1)fail();
  const videos=Object.values(graph).filter(n=>n.class_type==="CreateVideo");
  if(videos.length!==1||videos[0].inputs.fps!==fps)fail();
}

/** The pinned HyperFlow packs convert the direct length binding in compileLocal. */
export function assertHyperflowSecondsGraph(manifest: CapabilityManifestV2, graph: ApiGraph, binding: Binding): void {
  const expected = manifest.id === "hyperflow-h3-flash-i2v" ? "MiniMaxH3ReferenceToVideo" : "MiniMaxH3ImageToVideo";
  const videos = Object.values(graph).filter(node => node.class_type === "CreateVideo");
  if (!["hyperflow-h3-flash-t2v", "hyperflow-h3-flash-i2v", "hyperflow-h3-flash-flf2v"].includes(manifest.id)
    || manifest.timing?.fps !== 24 || binding.node !== "5" || binding.field !== "length"
    || graph["1"]?.class_type !== "HyperFlowGGUFLoader" || graph[binding.node]?.class_type !== expected
    || typeof graph[binding.node].inputs.length !== "number" || !videos.length || videos.some(node => node.inputs.fps !== 24)) {
    throw new Error("Invalid HyperFlow timing binding");
  }
}

export function secondsForSourceFrames(m: CapabilityManifestV2, required: number): number {
  const enough=4*Math.ceil((required-1)/4)+1;
  return (enough-(durationMapping(m)==="wan_seconds_floor_4n1" ? 1 : 0))/m.timing!.fps;
}

/** Fail closed: qualify only the known seconds-expression -> Wan 2.1 VAE output chain.
 * This checks structure, not provider names. It never rewrites a legacy graph.
 */
export function assertSecondsDurationGraph(graph: ApiGraph, binding: Binding, fps: number, outputNode?: string): void {
  const fail=():never=>{throw new Error("Invalid legacy timing binding: unqualified seconds-expression output chain");};
  const link=(v:unknown,index:number):string=>{
    if(!Array.isArray(v)||v.length!==2||typeof v[0]!=="string"||v[1]!==index||!graph[v[0]])return fail();
    return v[0];
  };
  const node=(id:string,type:string)=>{const n=graph[id];if(n?.class_type!==type)return fail();return n.inputs;};
  if(!Number.isFinite(fps)||fps<=0||binding.transform||binding.field!=="value")fail();
  if(typeof node(binding.node,"PrimitiveFloat").value!=="number")fail();
  const outputs=Object.entries(graph).filter(([,n])=>n.class_type==="SaveVideo");
  if(outputs.length!==1||(outputNode!==undefined&&outputs[0][0]!==outputNode))fail();
  const video=node(link(outputs[0][1].inputs.video,0),"CreateVideo");
  const fpsId=link(video.fps,0);
  if(node(fpsId,"PrimitiveFloat").value!==fps)fail();
  const decode=node(link(video.images,0),"VAEDecode");
  const vaeId=link(decode.vae,0);
  if(node(vaeId,"VAELoader").vae_name!=="wan_2.1_vae.safetensors")fail();
  let sample=decode.samples;
  const visited=new Set<string>();
  while(Array.isArray(sample)&&typeof sample[0]==="string"&&graph[sample[0]]?.class_type==="KSamplerAdvanced"){
    const id=link(sample,0);if(visited.has(id))fail();visited.add(id);
    sample=node(id,"KSamplerAdvanced").latent_image;
  }
  if(!visited.size)fail();
  const wan=node(link(sample,2),"WanImageToVideo");
  if(wan.batch_size!==1||link(wan.vae,0)!==vaeId)fail();
  const expression=node(link(wan.length,1),"ComfyMathExpression");
  if(typeof expression.expression!=="string"||expression.expression.replace(/\s/g,"")!=="floor(a*b+1)"||link(expression["values.a"],0)!==binding.node||link(expression["values.b"],0)!==fpsId)fail();
}

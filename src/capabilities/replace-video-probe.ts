import type {ApiGraph} from "../workflow/build";
import {assertLocalGraphPolicy} from "./policy";

export const REPLACE_VIDEO_PROBE_ID="replace-video-frame-probe";
export const SINGLE_VIDEO_PROBE_ID="replace-video-frame-probe-single";
export const SCENE_VIDEO_PROBE_ID="replace-video-frame-probe-scene";
export const SCENE_VIDEO_PROBE_VERSION="0.1.2";
export const isVideoProbe=(id:string)=>[REPLACE_VIDEO_PROBE_ID,SINGLE_VIDEO_PROBE_ID,SCENE_VIDEO_PROBE_ID].includes(id);
export const REPLACE_VIDEO_PROBE_VERSION="0.1.1";
/** SCAIL/Wan's temporal packing is 4n+1. Five is the smallest window
 * with two distinct decoded frames after frame zero. Not a motion-quality test. */
export const VIDEO_PROBE_FRAMES=5;
export const VIDEO_PROBE_INDICES=[1,4] as const;
const link=(v:unknown):v is [string,number]=>Array.isArray(v)&&v.length===2&&typeof v[0]==="string"&&Number.isInteger(v[1]);

/** Retain actual sampling/decoding, bound driving frames before GPU tracking,
 * and export two decoded frames. This never queues work or needs a still approval. */
export function buildReplaceVideoProbeGraph(submitted:ApiGraph):ApiGraph{
  const g=structuredClone(submitted);
  if(Object.keys(g).some(id=>id.startsWith("probe:")))throw new Error("Video probe node collision");
  const condition=g["213:114"],sampler=g["213:19"],decode=g["213:6"];
  if(condition?.class_type!=="WanSCAILToVideo"||sampler?.class_type!=="SamplerCustom"||decode?.class_type!=="VAEDecode")throw new Error("No supported SCAIL video sampler/decoder");
  if(JSON.stringify(sampler.inputs.latent_image)!==JSON.stringify(["213:114",2])||JSON.stringify(decode.inputs.samples)!==JSON.stringify(["213:19",1]))throw new Error("Video frames must come from the SCAIL sampler");
  // The two-reference branch still reads the driving output of the original
  // color node. Its default single-person selector must follow both identities.
  if(g["344"]?.inputs.value===true&&g["213:197"]?.class_type==="SCAIL2ColoredMask")g["213:197"].inputs.object_indices="0,1";
  function resolve(v:unknown,seen=new Set<string>()):unknown{
    if(!link(v)||g[v[0]]?.class_type!=="ComfySwitchNode")return v;
    if(seen.has(v[0]))throw new Error("Cyclic video probe switch");seen.add(v[0]);
    const n=g[v[0]],flag=n.inputs.switch,chosen=link(flag)?g[flag[0]]?.inputs.value:flag;
    if(typeof chosen!=="boolean")throw new Error("Unresolved video probe switch");
    return resolve(n.inputs[chosen?"on_true":"on_false"],seen);
  }
  for(const n of Object.values(g))for(const [k,v]of Object.entries(n.inputs))n.inputs[k]=resolve(v);
  condition.inputs.length=VIDEO_PROBE_FRAMES;condition.inputs.video_frame_offset=0;delete condition.inputs.previous_frames;
  if(g["213:177"]?.class_type==="ImageFromBatch")g["213:177"].inputs.length=VIDEO_PROBE_FRAMES;
  // Every image stream decoded from the source is sliced before resizing/SAM.
  const videos=Object.entries(g).filter(([,n])=>n.class_type==="GetVideoComponents");
  if(!videos.length)throw new Error("The driving video cannot be bounded");
  for(const [id]of videos){
    const crop=`probe:source:${id}`;
    for(const n of Object.values(g))for(const [k,v]of Object.entries(n.inputs))if(link(v)&&v[0]===id&&v[1]===0)n.inputs[k]=[crop,0];
    g[crop]={class_type:"ImageFromBatch",inputs:{image:[id,0],batch_index:0,length:VIDEO_PROBE_FRAMES}};
  }
  VIDEO_PROBE_INDICES.forEach(index=>{
    g[`probe:frame:${index}`]={class_type:"ImageFromBatch",inputs:{image:["213:6",0],batch_index:index,length:1}};
    g[`probe:save:${index}`]={class_type:"SaveImage",inputs:{images:[`probe:frame:${index}`,0],filename_prefix:`ras/video-probe-frame-${index}`}};
  });
  const keep=new Set<string>(),visiting=new Set<string>();
  function visit(id:string){
    if(keep.has(id))return;if(visiting.has(id))throw new Error("Cyclic video probe graph");
    const n=g[id];if(!n)throw new Error("Missing video probe dependency");visiting.add(id);
    for(const v of Object.values(n.inputs))if(link(v))visit(v[0]);
    visiting.delete(id);keep.add(id);
  }
  VIDEO_PROBE_INDICES.forEach(index=>visit(`probe:save:${index}`));
  const result=Object.fromEntries(Object.entries(g).filter(([id])=>keep.has(id)));
  if(Object.values(result).filter(n=>n.class_type==="SamplerCustom").length!==1||Object.values(result).filter(n=>n.class_type==="WanSCAILToVideo").length!==1||Object.values(result).some(n=>/CreateVideo|SaveVideo|UpscaleModel|ImageUpscaleWithModel/.test(n.class_type)))throw new Error("Video probe exceeds its bounded sampling graph");
  assertLocalGraphPolicy(result);return result;
}

/** Change only the reference preparation of the bounded SCAIL control. Keep the
 * complete scene, fit it explicitly to the same model canvas, and track that
 * same fitted image for both identity-color nodes. Never crop it to a person. */
export function buildSceneVideoProbeGraph(singleProbe:ApiGraph):ApiGraph{
  const g=structuredClone(singleProbe);
  for(const [id,kind]of Object.entries({"30":"LoadImage","213:114":"WanSCAILToVideo","213:198":"SAM3_VideoTrack","213:197":"SCAIL2ColoredMask","213:199":"SCAIL2ColoredMask","213:76":"CLIPVisionEncode"}))if(g[id]?.class_type!==kind)throw new Error(`Scene probe class drift at ${id}`);
  if(g["213:114"].inputs.length!==VIDEO_PROBE_FRAMES)throw new Error("Scene probe needs the same bounded temporal window");
  g["scene:fit"]={class_type:"ImageScale",inputs:{image:["30",0],upscale_method:"bicubic",width:["213:163",0],height:["213:163",1],crop:"disabled"}};
  g["scene:people"]={class_type:"PrimitiveStringMultiline",inputs:{value:"0,1"}};
  g["213:203"].inputs.value=false;
  g["213:198"].inputs.images=["scene:fit",0];
  for(const id of ["213:197","213:199"]){g[id].inputs.ref_track_data=["213:198",0];g[id].inputs.object_indices=["scene:people",0];}
  g["213:114"].inputs.reference_image=["scene:fit",0];
  g["213:114"].inputs.reference_image_mask=["213:199",1];
  g["213:76"].inputs.image=["scene:fit",0];
  const keep=new Set<string>();
  function visit(id:string){if(keep.has(id))return;const n=g[id];if(!n)throw new Error("Missing scene probe dependency");keep.add(id);for(const v of Object.values(n.inputs))if(link(v))visit(v[0]);}
  VIDEO_PROBE_INDICES.forEach(index=>visit(`probe:save:${index}`));
  const result=Object.fromEntries(Object.entries(g).filter(([id])=>keep.has(id)));
  if(Object.values(result).some(n=>n.class_type==="ImageCropToMask"))throw new Error("Scene reference must remain intact");
  assertLocalGraphPolicy(result);return result;
}

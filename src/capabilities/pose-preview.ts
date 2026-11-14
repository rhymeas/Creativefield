import {WAN_ANIMATE_MAX_DESIRED_FRAMES} from "./motion";
import type {CapabilityBundle} from "./types";
export const POSE_CHECKPOINT="sdpose_wholebody_fp16.safetensors";
export const POSE_CHECKPOINT_SHA256="63d01f9a7494560693b24767f4469d59c9d3266b31ff0a253e74d1e611442721";
export type PosePerson={pose_keypoints_2d:number[];hand_left_keypoints_2d?:number[];hand_right_keypoints_2d?:number[];face_keypoints_2d?:number[];foot_keypoints_2d?:number[]};
export type PoseFrame={canvas_width:number;canvas_height:number;people:PosePerson[]};
export type PosePreviewFrame={frameIndex:number;seconds:number;pose:PoseFrame};
export type PosePreviewSnapshot={validationVersion:1;previewId:string;sourceAssetId:string;sourceSha256:string;normalizedSha256:string;width:number;height:number;fps:24;frames:Array<{inputPort:string;assetId:string;sha256:string;frameIndex:number;seconds:number}>};
export function validatePosePreviewContract(bundle:CapabilityBundle){
  const {manifest:m,template:g}=bundle,c=m.posePreviewContract;if(!c)return [];if(!Array.isArray(c.frameInputs))return ["Invalid pose preview frame contract"];
  const errors:string[]=[],count=c.frameInputs.length,same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b),inputs=Array.from({length:count},(_,i)=>`frame_${i}`);
  if(c.kind!=="sdpose_preview_v1"||count<1||count>6||!same(c.frameInputs,inputs)||m.inputs.length!==count||!g)return ["Invalid pose preview frame contract"];
  for(const [i,id]of inputs.entries())if(!m.inputs.some(p=>p.id===id&&p.type==="image"&&p.required&&p.binding?.node===`load_${i}`&&p.binding.field==="image")||g[`load_${i}`]?.class_type!=="LoadImage"||!same(g.batch?.inputs[`images.image${i}`],[`load_${i}`,0]))errors.push("Pose preview frame binding changed");
  if(g.model?.class_type!=="CheckpointLoaderSimple"||g.model.inputs.ckpt_name!==POSE_CHECKPOINT||g.batch?.class_type!=="BatchImagesNode"||Object.keys(g.batch.inputs).length!==count||g.extract?.class_type!=="SDPoseKeypointExtractor"||!same(g.extract.inputs.model,["model",0])||!same(g.extract.inputs.vae,["model",2])||!same(g.extract.inputs.image,["batch",0])||g.extract.inputs.batch_size!==1)errors.push("Pose preview extractor changed");
  if(g[c.keypointNode]?.class_type!=="PreviewAny"||!same(g[c.keypointNode].inputs.source,["extract",0])||g.draw?.class_type!=="SDPoseDrawKeypoints"||!same(g.draw.inputs.keypoints,["extract",0])||g.draw.inputs.score_threshold!==.3||g[c.artifactNode]?.class_type!=="SaveImage"||!same(g[c.artifactNode].inputs.images,["draw",0]))errors.push("Pose preview output binding changed");
  const artifacts=m.imageArtifacts?.artifacts;if(m.imageArtifacts?.maxArtifacts!==count||artifacts?.length!==1||artifacts[0].node!==c.artifactNode||artifacts[0].cardinality.min!==count||artifacts[0].cardinality.max!==count)errors.push("Pose preview output count changed");
  return errors;
}
/** Normalized 24-CFR driving input only. Short clips never get duplicate samples. */
export function poseFramePlan(frameCount:number){
  if(!Number.isSafeInteger(frameCount)||frameCount<1||frameCount>WAN_ANIMATE_MAX_DESIRED_FRAMES)throw Error("Use a normalized driving clip of 1–641 frames at 24 FPS.");
  const count=Math.min(6,frameCount);return Array.from({length:count},(_,i)=>{const frameIndex=count===1?0:Math.round(i*(frameCount-1)/(count-1));return {frameIndex,seconds:frameIndex/24};});
}
/** Parse actual SDPose/OpenPose output without inventing missing joints. */
export function readPoseFrames(value:unknown,expected:{count:number;width:number;height:number}):PoseFrame[]|null{
  if(!Number.isInteger(expected.count)||expected.count<1||expected.count>6||!Array.isArray(value)||value.length!==expected.count||![expected.width,expected.height].every(n=>Number.isInteger(n)&&n>=1&&n<=4096))return null;
  const sizes={pose_keypoints_2d:54,hand_left_keypoints_2d:63,hand_right_keypoints_2d:63,face_keypoints_2d:210,foot_keypoints_2d:18} as const,limit=Math.max(expected.width,expected.height)*8;
  for(const frame of value){
    if(!frame||frame.canvas_width!==expected.width||frame.canvas_height!==expected.height||!Array.isArray(frame.people)||frame.people.length>8)return null;
    for(const person of frame.people){
      if(!person||!Array.isArray(person.pose_keypoints_2d))return null;
      // SDPose heatmap scores can exceed 1; they are not calibrated probabilities.
      for(const [key,length] of Object.entries(sizes)){const points=person[key];if(points===undefined&&key!=="pose_keypoints_2d")continue;if(!Array.isArray(points)||points.length!==length||points.some((n,i)=>typeof n!=="number"||!Number.isFinite(n)||i%3!==2&&Math.abs(n)>limit))return null;}
    }
  }return value.map(frame=>({canvas_width:frame.canvas_width,canvas_height:frame.canvas_height,people:frame.people.map((person:PosePerson)=>Object.fromEntries(Object.keys(sizes).filter(key=>person[key as keyof PosePerson]!==undefined).map(key=>[key,[...person[key as keyof PosePerson]!]])) as PosePerson)}));
}
/** Select a measured sample; this never interpolates a skeleton. */
export function poseFrameAt(frames:PosePreviewFrame[],seconds:number){
  if(!Number.isFinite(seconds)||seconds<0)return -1;let selected=-1;for(let i=0;i<frames.length;i++){if(frames[i].seconds>seconds)break;selected=i;}return selected;
}

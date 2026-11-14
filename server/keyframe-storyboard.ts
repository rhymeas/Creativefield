import type {CapabilityManifestV2} from '../src/capabilities/types';
import {planKeyframeSegments,qualifyKeyframeTiming} from '../src/team/keyframe-plan';
import {HttpError} from './auth';

/** Validate a segment before queueing and preserve its exact boundary in assembly. */
export function keyframeShotTiming(model:CapabilityManifestV2,seconds:number,fps:number,index:number,inputs:Record<string,string>,prompt:string,previousEnd?:string){
 const count=seconds*fps,rounded=Math.round(count),start=inputs.start_image,end=inputs.end_image;
 if(!start||!end||index>0&&start!==previousEnd)throw new HttpError(422,'Keyframe segments must share the same image at each join.');
 if(!Number.isFinite(count)||Math.abs(count-rounded)>1e-7)throw new HttpError(422,'Keyframe positions must land on whole output frames.');
 try{
  const [segment]=qualifyKeyframeTiming(model,planKeyframeSegments([{assetId:start,frame:0},{assetId:end,frame:rounded}],[prompt]),fps);
  return {controlSeconds:segment.controlSeconds,generationFrames:segment.frameCount,frames:segment.frameCount-(index?1:0),assemblyStartFrame:index?1:0};
 }catch(error){throw new HttpError(422,error instanceof Error?error.message:'Invalid keyframe timing.');}
}

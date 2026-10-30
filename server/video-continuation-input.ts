import {HttpError} from "./auth";
import type {DiskStore} from "./storage";
import {inspectVideoSource} from "./video-extension-media";
import {MAX_CONTINUATION_SOURCE_FRAMES,type VideoExtensionPlan,type VideoSourceEnvelope} from "./video-extension-plan";

export function continuationSourceIssues(source:Pick<VideoSourceEnvelope,"width"|"height"|"frameCount"|"frameRate">):string[]{
  const issues:string[]=[];
  if(source.frameRate.numerator/source.frameRate.denominator!==16)issues.push("Forward extension requires a 16 FPS source.");
  if(source.width%16||source.height%16||Math.max(source.width,source.height)>832||source.width*source.height>399360)issues.push("Forward extension requires dimensions divisible by16, at most832 per side and399360 pixels.");
  if(source.frameCount>MAX_CONTINUATION_SOURCE_FRAMES)issues.push("Trim the source to at most161 frames before extending it; the native loader decodes the whole source.");
  return issues;
}
export async function admitVideoContinuation(asset:{id:string;project_id:string|null;storage_key:string;sha256:string},workspaceId:string,store:DiskStore,controls:Record<string,unknown>,plan:VideoExtensionPlan){
  if(!plan.continuation||plan.operation!=="forward_extend"||plan.source.sourceAssetId!==asset.id||plan.source.projectId!==asset.project_id)throw new HttpError(422,"Continuation does not match the source plan.");
  const derived={generation_frames:plan.continuation.generationFrames,overlap_frames:plan.continuation.overlapFrames,context_start_frame:plan.continuation.contextStartFrame};
  for(const [key,value] of Object.entries(derived))if(controls[key]!==value)throw new HttpError(422,"Continuation context controls do not match the server plan.");
  const actual=await inspectVideoSource(await store.file(workspaceId,asset.storage_key),{sourceAssetId:asset.id,projectId:asset.project_id!});
  const issues=continuationSourceIssues(actual);if(issues.length)throw new HttpError(422,issues[0]);
  if(actual.sha256!==asset.sha256||actual.sha256!==plan.source.sha256||actual.timestampDigest!==plan.source.timestampDigest||actual.frameCount!==plan.source.frameCount)throw new HttpError(422,"The source video changed after continuation planning.");
  return actual;
}

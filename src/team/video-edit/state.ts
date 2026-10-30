import type {Asset} from "../api";

export function videoModeFromHash(hash:string):"create"|"edit"|"trim"|"storyboard"|"effects"|"transform"|"replace"|null {
  const [section,mode]=hash.replace(/^#/,"").split("/");
  return section==="video"&&(mode==="create"||mode==="edit"||mode==="trim"||mode==="storyboard"||mode==="effects"||mode==="transform"||mode==="replace")?mode:null;
}

export type VideoEditDraft={videoAssetId:string;startFrame:string;endFrameExclusive:string;audioPolicy:"mute"|"preserve";extensionFrames?:string;overlapFrames?:string;prompt?:string};
export const defaultVideoEditDraft:VideoEditDraft={videoAssetId:"",startFrame:"0",endFrameExclusive:"",audioPolicy:"preserve"};

export type VideoSourceEnvelope={
  sourceAssetId:string;projectId:string;sha256:string;bytes:number;width:number;height:number;
  frameRate:{numerator:16;denominator:1};frameCount:number;hasAudio:boolean;container:string;videoCodec:string;
};
export type VideoEditPlan={
  contractVersion:1;operation:"trim"|"forward_extend";source:VideoSourceEnvelope;
  trim:{startFrame:number;endFrameExclusive:number;frames:number};
  continuation:null|Record<string,unknown>;
  output:{frameRate:{numerator:16;denominator:1};frames:number;durationTicks:number;timeBase:{numerator:1;denominator:16};audioPolicy:"mute"|"preserve";
    audio:null|{sourceStartFrame:number;sourceEndFrameExclusive:number;continuation:"silent"|null;sampleRate:48000;channels:2}};
  planDigest:string;
};
export type VideoEditRequirements={
  contractVersion:1;
  trim:{state:"ready"|"install_required";missing:string[];instructions:string;versions?:{ffmpeg?:string;ffprobe?:string}};
  forwardExtension:{workflow:{state:string;reasons:string[];missing:unknown[]};tools:unknown};
  audioPolicies:("mute"|"preserve")[];
};
export type VideoEditJob={
  id:string;project_id:string;source_asset_id:string;created_by:string;state:string;error:string|null;
  output_asset_id:string|null;plan:VideoEditPlan;created_at:string;updated_at:string;
};

const integer=(value:string)=>value.trim()!==""&&Number.isSafeInteger(Number(value));
export function videoEditDraftIssues(draft:VideoEditDraft,assets:Asset[],plan:VideoEditPlan|null,extensionWorkerId?:string,maxGenerationFrames=81):string[]{
  const issues:string[]=[],asset=assets.find(item=>item.id===draft.videoAssetId&&item.media_type==="video");
  if(!asset)issues.push("Choose a project video.");
  if(!plan||plan.source.sourceAssetId!==draft.videoAssetId)issues.push("Wait for the server to inspect the selected video.");
  if(!integer(draft.startFrame)||Number(draft.startFrame)<0)issues.push("Start frame must be a whole number at or after zero.");
  if(!integer(draft.endFrameExclusive)||Number(draft.endFrameExclusive)<1)issues.push("End frame must be a positive whole number.");
  if(integer(draft.startFrame)&&integer(draft.endFrameExclusive)&&Number(draft.endFrameExclusive)<=Number(draft.startFrame))issues.push("End frame must be after start frame.");
  if(plan&&integer(draft.endFrameExclusive)&&Number(draft.endFrameExclusive)>plan.source.frameCount)issues.push(`End frame must not exceed ${plan.source.frameCount}.`);
  if(draft.extensionFrames!==undefined&&(!integer(draft.extensionFrames)||Number(draft.extensionFrames)<0||Number(draft.extensionFrames)>80))issues.push("Extension must be 0–80 whole frames.");
  if(Number(draft.extensionFrames??0)>0){
    const extra=Number(draft.extensionFrames),overlap=Number(draft.overlapFrames??5),retained=Number(draft.endFrameExclusive)-Number(draft.startFrame);
    if(!extensionWorkerId)issues.push("Choose a ready local continuation worker in Models.");
    if(!integer(draft.extensionFrames!)||extra<1||extra>80)issues.push("Extension must be1–80 whole frames.");
    if(!Number.isSafeInteger(overlap)||overlap<1||overlap>retained)issues.push("Overlap must fit inside the retained video.");
    if(4*Math.ceil((extra+overlap-1)/4)+1>maxGenerationFrames)issues.push(`Extension and overlap require more than ${maxGenerationFrames} generated frames.`);
    if(!draft.prompt?.trim())issues.push("Describe the scene and movement to continue.");
    if(plan){const s=plan.source;if(s.frameRate.numerator/s.frameRate.denominator!==16)issues.push("Continuation requires a16FPS source; trim first.");if(s.width%16||s.height%16||Math.max(s.width,s.height)>832||s.width*s.height>399360)issues.push("Continuation requires VACE-sized video; prepare a smaller clip first.");if(s.frameCount>161)issues.push("Trim the source to161frames or fewer before extending.");}
  }
  return [...new Set(issues)];
}

export const planRequest=(projectId:string,sourceAssetId:string,startFrame:number,endFrameExclusive:number,audioPolicy:"mute"|"preserve"="mute")=>({projectId,sourceAssetId,startFrame,endFrameExclusive,extensionFrames:0,overlapFrames:0,audioPolicy});

export function buildVideoEditRequest(draft:VideoEditDraft,assets:Asset[],plan:VideoEditPlan|null,projectId:string,idempotencyKey:string,extensionWorkerId?:string,maxGenerationFrames=81){
  const issues=videoEditDraftIssues(draft,assets,plan,extensionWorkerId,maxGenerationFrames);if(issues.length)throw new Error(issues[0]);
  const audioPolicy=plan?.source.hasAudio?draft.audioPolicy:"mute";
  const extension=Number(draft.extensionFrames??0);
  if(extension>0)return {...planRequest(projectId,draft.videoAssetId,Number(draft.startFrame),Number(draft.endFrameExclusive),audioPolicy),extensionFrames:extension,overlapFrames:Number(draft.overlapFrames??5),workerId:extensionWorkerId!,idempotencyKey,controls:{prompt:draft.prompt!.trim()}};
  return {...planRequest(projectId,draft.videoAssetId,Number(draft.startFrame),Number(draft.endFrameExclusive),audioPolicy),idempotencyKey,controls:{}};
}

export const videoEditActive=(state:string)=>["pending","generating","stitching","cancel_requested"].includes(state);

export function draftFromVideoEditJob(job:VideoEditJob):VideoEditDraft{
  return {...defaultVideoEditDraft,videoAssetId:job.source_asset_id,startFrame:String(job.plan.trim.startFrame),endFrameExclusive:String(job.plan.trim.endFrameExclusive),audioPolicy:job.plan.output.audioPolicy,
    extensionFrames:String(job.plan.continuation?.requestedFrames??0),overlapFrames:String(job.plan.continuation?.overlapFrames??5)};
}

/** Source-preview duration from the inspected source rate, not the normalized output rate. */
export function previewSeconds(frames:number,frameRate:{numerator:number;denominator:number}){
  const fps=frameRate.numerator/frameRate.denominator;
  return Number.isFinite(frames)&&frames>0&&Number.isFinite(fps)&&fps>0?frames/fps:0;
}

import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createReadStream} from "node:fs";
import {lstat,mkdir,realpath,readdir,unlink,rmdir} from "node:fs/promises";
import path from "node:path";
import type {DiskStore} from "./storage";
import type {VideoExtensionPlan} from "./video-extension-plan";
import {inspectNormalizedVideo,inspectVideoSource,VideoExtensionMediaError,VideoExtensionToolUnavailableError} from "./video-extension-media";

const execute=promisify(execFile);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class VideoStitchError extends Error{}
export type VideoStitchResult=Awaited<ReturnType<DiskStore["put"]>>&{metadata:Record<string,unknown>};

async function safeRemove(dir:string,root:string){
  const stat=await lstat(dir).catch((error:NodeJS.ErrnoException)=>{if(error.code==="ENOENT")return null;throw error;});
  if(!stat)return;
  if(stat.isSymbolicLink()||!stat.isDirectory()||path.dirname(await realpath(dir))!==root)throw new VideoStitchError("Invalid video-extension attempt directory");
  for(const entry of await readdir(dir,{withFileTypes:true})){
    if(!entry.isFile())throw new VideoStitchError("Invalid video-extension attempt contents");
    await unlink(path.join(dir,entry.name));
  }
  await rmdir(dir);
}

export async function cleanupVideoStitchAttempt(store:DiskStore,workspaceId:string,attempt:{attemptId:string,candidateId:string}){
  if(!UUID.test(attempt.attemptId)||!UUID.test(attempt.candidateId))throw new VideoStitchError("Invalid persisted video-extension attempt identity");
  const scratch=path.join(store.root,".video-extension");await mkdir(scratch,{recursive:true});
  if((await lstat(scratch)).isSymbolicLink())throw new VideoStitchError("Invalid video-extension scratch directory");
  const root=await realpath(scratch);await safeRemove(path.join(root,`attempt-${attempt.attemptId}`),root);await store.discardCandidate(workspaceId,attempt.candidateId);
}

/** Deterministic frame-domain trim and hard-cut continuation assembly. */
export async function stitchVideoExtension(store:DiskStore,workspaceId:string,sourceKey:string,plan:VideoExtensionPlan,continuationKey:string|null,cancel:AbortSignal,attempt:{attemptId:string,candidateId:string}):Promise<VideoStitchResult>{
  if(!UUID.test(attempt.attemptId)||!UUID.test(attempt.candidateId))throw new VideoStitchError("Invalid persisted video-extension attempt identity");
  const signal=AbortSignal.any([cancel,AbortSignal.timeout(10*60*1000)]),scratch=path.join(store.root,".video-extension");await mkdir(scratch,{recursive:true});
  if((await lstat(scratch)).isSymbolicLink())throw new VideoStitchError("Invalid video-extension scratch directory");
  const root=await realpath(scratch),dir=path.join(root,`attempt-${attempt.attemptId}`),target=path.join(dir,"output.mp4");let saved:Awaited<ReturnType<DiskStore["put"]>>|undefined;
  try{
    await cleanupVideoStitchAttempt(store,workspaceId,attempt);
    await mkdir(dir,{recursive:false});
    const source=await store.file(workspaceId,sourceKey),currentSource=await inspectVideoSource(source,{sourceAssetId:plan.source.sourceAssetId,projectId:plan.source.projectId},signal);
    if(currentSource.sha256!==plan.source.sha256||currentSource.bytes!==plan.source.bytes||currentSource.width!==plan.source.width||currentSource.height!==plan.source.height||currentSource.frameCount!==plan.source.frameCount||currentSource.timestampDigest!==plan.source.timestampDigest||currentSource.ffmpegVersion!==plan.source.ffmpegVersion||currentSource.ffprobeVersion!==plan.source.ffprobeVersion)throw new VideoStitchError("Source video envelope or verification tools changed after planning");
    const args=["-hide_banner","-loglevel","error","-nostdin","-y","-protocol_whitelist","file,pipe","-i",source];
    const preserveAudio=plan.output.audioPolicy==="preserve";
    if(preserveAudio&&!plan.source.hasAudio)throw new VideoStitchError("Plan cannot preserve audio from a silent source");
    let filter=`[0:v:0]trim=start_frame=${plan.trim.startFrame}:end_frame=${plan.trim.endFrameExclusive},setpts=PTS-STARTPTS,fps=16,setsar=1,format=yuv420p[src]`,map="[src]",audioMap:string|null=null;
    if(plan.continuation){
      if(!continuationKey)throw new VideoStitchError("Forward extension requires a verified continuation artifact");
      const continuation=await store.file(workspaceId,continuationKey),facts=await inspectNormalizedVideo(continuation,signal),expected=plan.continuation.generationFrames;
      if(facts.width!==plan.source.width||facts.height!==plan.source.height||facts.frameCount!==expected||facts.hasAudio||facts.frameRate.numerator/facts.frameRate.denominator!==16)throw new VideoStitchError("Continuation artifact does not match the frozen generation envelope");
      args.push("-protocol_whitelist","file,pipe","-i",continuation);
      filter+=`;[1:v:0]trim=start_frame=${plan.continuation.overlapFrames}:end_frame=${plan.continuation.overlapFrames+plan.continuation.requestedFrames},setpts=PTS-STARTPTS,fps=16,setsar=1,format=yuv420p[cont];[src][cont]concat=n=2:v=1:a=0[out]`;map="[out]";
    }
    if(preserveAudio){
      const sourceFps=plan.source.frameRate.numerator/plan.source.frameRate.denominator,start=plan.trim.startFrame/sourceFps,end=plan.trim.endFrameExclusive/sourceFps,duration=plan.output.frames/16;
      filter+=`;[0:a:0]atrim=start=${start.toFixed(4)}:end=${end.toFixed(4)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${duration.toFixed(4)},asetpts=N/SR/TB[a]`;audioMap="[a]";
    }
    args.push("-filter_complex_threads","1","-filter_complex",filter,"-map",map);
    if(audioMap)args.push("-map",audioMap,"-c:a","aac","-b:a","128k","-ar","48000","-ac","2");else args.push("-an");
    args.push("-c:v","libx264","-threads","2","-preset","veryfast","-crf","20","-pix_fmt","yuv420p","-map_metadata","-1","-movflags","+faststart","-frames:v",String(plan.output.frames),"-fs",String(store.maxBytes+1),target);
    try{await execute(process.env.FFMPEG_PATH??"ffmpeg",args,{windowsHide:true,timeout:120000,maxBuffer:2*1024*1024,signal});}catch(error){if(signal.aborted)throw new VideoStitchError("Video trim or stitch was canceled or timed out");throw new VideoStitchError("FFmpeg could not produce the planned video artifact");}
    const facts=await inspectNormalizedVideo(target,signal),expectedSeconds=plan.output.frames/16;
    if(facts.width!==plan.source.width||facts.height!==plan.source.height||facts.frameRate.numerator/facts.frameRate.denominator!==16||facts.frameCount!==plan.output.frames||facts.hasAudio!==preserveAudio)throw new VideoStitchError("Published video failed exact frame, geometry or audio verification");
    if(preserveAudio&&(facts.audioSeconds===null||Math.abs(facts.audioSeconds-expectedSeconds)>0.12))throw new VideoStitchError("Published video failed exact audio timing verification");
    saved=await store.put(workspaceId,createReadStream(target),attempt.candidateId);
    return {...saved,metadata:{validationVersion:1,planDigest:plan.planDigest,operation:plan.operation,sourceSha256:plan.source.sha256,sourceRange:plan.trim,continuation:plan.continuation,output:{...plan.output,...facts},artifactSha256:saved.sha256}};
  }catch(error){
    if(saved)await store.remove(workspaceId,saved.key).catch(()=>{});
    if(error instanceof VideoStitchError)throw error;
    if(error instanceof VideoExtensionMediaError||error instanceof VideoExtensionToolUnavailableError)throw new VideoStitchError(error.message);
    throw new VideoStitchError("Video trim or stitch failed; check media, storage and FFmpeg requirements");
  }finally{await safeRemove(dir,root).catch(()=>{});}
}


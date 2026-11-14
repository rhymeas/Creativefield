import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {chmod,lstat,mkdir,mkdtemp,readdir,realpath,rmdir,stat,unlink} from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";
import type {DiskStore} from "./storage";

const execute=promisify(execFile);
const TOOL_TIMEOUT_MS=10_000;
const ENCODE_TIMEOUT_MS=120_000;
const VERIFY_TIMEOUT_MS=30_000;
const ATTEMPT_TIMEOUT_MS=3*60_000;
const MAX_DURATION_SECONDS=300;
const MAX_BUFFER_BYTES=2*1024*1024;
// Only self-contained media demuxers belong here. Indirect inputs (concat, HLS,
// playlists, image sequences) would let a small stored manifest consume bytes
// that are not covered by the source hash recorded in export provenance.
const SELF_CONTAINED_DEMUXERS="mov,matroska,webm,avi,mpegts,mpeg,mpegvideo,ogg";

export type ExportProfile={
  readonly id:"mp4-h264-720p24"|"mp4-h264-1080p24";
  readonly version:1;
  readonly label:string;
  readonly container:"mp4";
  readonly videoCodec:"h264";
  readonly encoder:"libx264";
  readonly width:1280|1920;
  readonly height:720|1080;
  readonly fps:24;
  readonly pixelFormat:"yuv420p";
  readonly sampleAspectRatio:"1:1";
  readonly audio:"mute";
  readonly preset:"medium";
  readonly crf:18;
};

function freezeProfile(profile:ExportProfile):ExportProfile{return Object.freeze(profile);}

/** Versioned delivery contracts. Changing an encoding declaration requires a new ID/version. */
export const EXPORT_PROFILES=Object.freeze({
  "mp4-h264-720p24":freezeProfile({id:"mp4-h264-720p24",version:1,label:"720p / 24 FPS / H.264 / mute",container:"mp4",videoCodec:"h264",encoder:"libx264",width:1280,height:720,fps:24,pixelFormat:"yuv420p",sampleAspectRatio:"1:1",audio:"mute",preset:"medium",crf:18}),
  "mp4-h264-1080p24":freezeProfile({id:"mp4-h264-1080p24",version:1,label:"1080p / 24 FPS / H.264 / mute",container:"mp4",videoCodec:"h264",encoder:"libx264",width:1920,height:1080,fps:24,pixelFormat:"yuv420p",sampleAspectRatio:"1:1",audio:"mute",preset:"medium",crf:18}),
} satisfies Record<ExportProfile["id"],ExportProfile>);
export type ExportProfileId=keyof typeof EXPORT_PROFILES;

export class ExportProfileError extends Error{}

export function exportProfile(id:string):ExportProfile{
  if(!Object.prototype.hasOwnProperty.call(EXPORT_PROFILES,id))throw new ExportProfileError("Unknown export profile");
  const profile=(EXPORT_PROFILES as Record<string,ExportProfile|undefined>)[id];
  if(!profile)throw new ExportProfileError("Unknown export profile");
  return profile;
}

type ToolResult={stdout:string;stderr:string};
async function runTool(command:string,args:string[],timeout:number,signal?:AbortSignal):Promise<ToolResult>{
  return execute(command,args,{encoding:"utf8",timeout,maxBuffer:MAX_BUFFER_BYTES,windowsHide:true,signal});
}

export type ExportReadiness={
  profileId:ExportProfileId;
  state:"ready"|"install_required";
  missing:string[];
  instructions:string;
};

/** Readiness is profile-specific even though the current profiles share the same mute-only toolchain. */
export async function exportReadiness(id:ExportProfileId):Promise<ExportReadiness>{
  const profile=exportProfile(id),missing:string[]=[];
  const ffmpeg=process.env.FFMPEG_PATH??"ffmpeg",ffprobe=process.env.FFPROBE_PATH??"ffprobe";
  try{
    const encoders=await runTool(ffmpeg,["-hide_banner","-encoders"],TOOL_TIMEOUT_MS);
    if(!/\blibx264\b/.test(encoders.stdout))missing.push("FFmpeg with the libx264 encoder");
  }catch{missing.push("FFmpeg with the libx264 encoder");}
  try{await runTool(ffprobe,["-version"],TOOL_TIMEOUT_MS);}catch{missing.push("FFprobe");}
  return {
    profileId:profile.id,
    state:missing.length?"install_required":"ready",
    missing:[...new Set(missing)],
    instructions:"Install FFmpeg with libx264 and FFprobe on the team server, or set FFMPEG_PATH and FFPROBE_PATH. These mute-only profiles do not require an audio encoder.",
  };
}

type ProbeStream={
  codec_type?:string;codec_name?:string;pix_fmt?:string;width?:number;height?:number;
  r_frame_rate?:string;avg_frame_rate?:string;nb_read_frames?:string;duration?:string;
  sample_aspect_ratio?:string;start_time?:string;tags?:Record<string,string>;
};
type ProbeData={streams?:ProbeStream[];format?:{format_name?:string;duration?:string;nb_streams?:number}};

function numberRate(value:string|undefined):number{
  const [numerator,denominator]=String(value??"").split("/").map(Number);
  return denominator>0?numerator/denominator:Number.NaN;
}

async function probe(file:string,signal:AbortSignal,countFrames:boolean):Promise<ProbeData>{
  const args=["-v","error","-protocol_whitelist","file","-format_whitelist",SELF_CONTAINED_DEMUXERS,"-err_detect","explode"];
  if(countFrames)args.push("-count_frames");
  args.push("-show_streams","-show_format","-of","json",file);
  const result=await runTool(process.env.FFPROBE_PATH??"ffprobe",args,VERIFY_TIMEOUT_MS,signal);
  if(result.stderr.trim())throw new ExportProfileError("FFprobe reported damaged media");
  return JSON.parse(result.stdout) as ProbeData;
}

async function sha256(file:string,signal?:AbortSignal):Promise<string>{
  const hash=createHash("sha256");
  for await(const chunk of createReadStream(file)){signal?.throwIfAborted();hash.update(chunk);}
  signal?.throwIfAborted();
  return hash.digest("hex");
}

function sourceDuration(data:ProbeData):number{
  const videos=data.streams?.filter(stream=>stream.codec_type==="video")??[];
  if(videos.length!==1)throw new ExportProfileError("Export requires exactly one source video stream");
  // Matroska commonly omits stream.duration. Its per-stream DURATION tag
  // avoids extending a mute video to the end of a longer audio stream.
  const video=videos[0],tag=/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(video.tags?.DURATION??"");
  const taggedDuration=tag&&Number(tag[2])<60&&Number(tag[3])<60?Number(tag[1])*3600+Number(tag[2])*60+Number(tag[3]):undefined;
  const duration=Number(video.duration??taggedDuration??data.format?.duration);
  if(!Number.isFinite(duration)||duration<=0||duration>MAX_DURATION_SECONDS)throw new ExportProfileError(`Source video duration must be greater than zero and no more than ${MAX_DURATION_SECONDS} seconds`);
  return duration;
}

function verifyOutput(data:ProbeData,profile:ExportProfile,expectedFrames:number){
  const streams=data.streams??[],videos=streams.filter(stream=>stream.codec_type==="video"),video=videos[0];
  if(streams.length!==1||videos.length!==1)throw new ExportProfileError("Export verification requires exactly one video stream and no audio or data streams");
  const formats=(data.format?.format_name??"").split(",");
  if(!formats.includes("mp4"))throw new ExportProfileError("Export verification failed: container is not MP4");
  if(video.codec_name!==profile.videoCodec||video.width!==profile.width||video.height!==profile.height||video.pix_fmt!==profile.pixelFormat)throw new ExportProfileError("Export verification failed: video codec, dimensions or pixel format differs from the profile");
  if(video.sample_aspect_ratio!==profile.sampleAspectRatio)throw new ExportProfileError("Export verification failed: pixels are not square");
  if(numberRate(video.r_frame_rate)!==profile.fps||numberRate(video.avg_frame_rate)!==profile.fps)throw new ExportProfileError("Export verification failed: frame rate is not the profile's fixed FPS");
  const frames=Number(video.nb_read_frames),duration=Number(video.duration??data.format?.duration),expectedDuration=expectedFrames/profile.fps;
  if(!Number.isSafeInteger(frames)||frames!==expectedFrames)throw new ExportProfileError(`Export verification failed: decoded frame count ${frames} differs from expected ${expectedFrames}`);
  if(!Number.isFinite(duration)||Math.abs(duration-expectedDuration)>1/profile.fps/10)throw new ExportProfileError("Export verification failed: duration differs from frame count divided by FPS");
  if(Number(video.start_time??0)!==0)throw new ExportProfileError("Export verification failed: video does not start at timestamp zero");
  return {frames,durationSeconds:duration};
}

async function privateAttempt(root:string):Promise<{root:string;dir:string}>{
  await mkdir(root,{recursive:true,mode:0o700});
  if((await lstat(root)).isSymbolicLink())throw new ExportProfileError("Invalid export scratch directory");
  const resolved=await realpath(root),dir=await mkdtemp(path.join(resolved,"attempt-"));
  await chmod(dir,0o700).catch(()=>{});
  if(path.dirname(await realpath(dir))!==resolved)throw new ExportProfileError("Invalid export attempt directory");
  return {root:resolved,dir};
}

async function cleanAttempt(attempt:{root:string;dir:string}):Promise<void>{
  if(path.dirname(await realpath(attempt.dir))!==attempt.root)throw new ExportProfileError("Refusing to clean an unexpected export path");
  for(const entry of await readdir(attempt.dir,{withFileTypes:true})){
    if(entry.isDirectory())throw new ExportProfileError("Unexpected directory in export scratch");
    await unlink(path.join(attempt.dir,entry.name));
  }
  await rmdir(attempt.dir);
}

export type ExportResult={
  key:string;bytes:number;sha256:string;
  metadata:{
    contract:"comfyfield_export_v1";profile:ExportProfile;sourceSha256:string;
    width:number;height:number;container:"mp4";codec:"h264";pixelFormat:"yuv420p";fps:24;
    frames:number;durationSeconds:number;sampleAspectRatio:"1:1";hasAudio:false;
  };
};

/** Encode a validated DiskStore asset into one exact, mute-only delivery profile. */
export async function exportVideo(store:DiskStore,workspaceId:string,sourceKey:string,profileId:ExportProfileId,cancel:AbortSignal):Promise<ExportResult>{
  const profile=exportProfile(profileId),signal=AbortSignal.any([cancel,AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]);
  const source=await store.file(workspaceId,sourceKey),attempt=await privateAttempt(path.join(store.root,".exports"));
  let published:Awaited<ReturnType<DiskStore["put"]>>|undefined;
  let result:ExportResult|undefined,failure:Error|undefined;
  try{
    signal.throwIfAborted();
    const sourceSha256=await sha256(source,signal),sourceInfo=await probe(source,signal,false),duration=sourceDuration(sourceInfo),expectedFrames=Math.max(1,Math.round(duration*profile.fps));
    const output=path.join(attempt.dir,"export.mp4");
    // The one-frame tpad makes duration rounding deterministic without extending the export beyond expectedFrames.
    const filter=`fps=${profile.fps}:round=near,tpad=stop_mode=clone:stop_duration=${1/profile.fps},scale=trunc(iw*sar/2)*2:ih,setsar=1,scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=${profile.pixelFormat},trim=end_frame=${expectedFrames},setpts=N/(${profile.fps}*TB)`;
    const args=["-hide_banner","-loglevel","error","-nostdin","-y","-protocol_whitelist","file","-format_whitelist",SELF_CONTAINED_DEMUXERS,"-i",source,"-map","0:v:0","-an","-sn","-dn","-vf",filter,"-frames:v",String(expectedFrames),"-fps_mode","cfr","-c:v",profile.encoder,"-preset",profile.preset,"-crf",String(profile.crf),"-pix_fmt",profile.pixelFormat,"-profile:v","high","-level:v","4.1","-map_metadata","-1","-movflags","+faststart","-fs",String(store.maxBytes+1),output];
    await runTool(process.env.FFMPEG_PATH??"ffmpeg",args,ENCODE_TIMEOUT_MS,signal);
    const bytes=(await stat(output)).size;
    if(bytes<=0||bytes>store.maxBytes)throw new ExportProfileError("Export is empty or exceeds the configured media-size limit");
    const verified=verifyOutput(await probe(output,signal,true),profile,expectedFrames);
    signal.throwIfAborted();
    if(await sha256(source,signal)!==sourceSha256)throw new ExportProfileError("Source media changed during export; run the export again");
    signal.throwIfAborted();
    published=await store.put(workspaceId,createReadStream(output));
    signal.throwIfAborted();
    result={ ...published,metadata:{contract:"comfyfield_export_v1",profile,sourceSha256,width:profile.width,height:profile.height,container:profile.container,codec:profile.videoCodec,pixelFormat:profile.pixelFormat,fps:profile.fps,frames:verified.frames,durationSeconds:verified.durationSeconds,sampleAspectRatio:profile.sampleAspectRatio,hasAudio:false} };
  }catch(error){
    if(published)await store.remove(workspaceId,published.key).catch(()=>{});
    failure=error instanceof ExportProfileError?error:signal.aborted?new ExportProfileError("Export was canceled or timed out; the source asset was preserved"):new ExportProfileError("Export failed; check FFmpeg, FFprobe, libx264, source media and configured storage capacity");
  }
  try{await cleanAttempt(attempt);}catch{
    // Preserve the primary encode/probe failure. On an otherwise successful run, do not publish if private cleanup failed.
    if(!failure){
      if(published)await store.remove(workspaceId,published.key).catch(()=>{});
      failure=new ExportProfileError("Export scratch cleanup failed; no output was published");
    }
  }
  if(!failure&&signal.aborted){
    if(published)await store.remove(workspaceId,published.key).catch(()=>{});
    failure=new ExportProfileError("Export was canceled or timed out; the source asset was preserved");
  }
  if(failure)throw failure;
  return result!;
}

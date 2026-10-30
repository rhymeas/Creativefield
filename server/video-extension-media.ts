import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {stat} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import type {VideoSourceEnvelope} from "./video-extension-plan";

const execute=promisify(execFile),MAX_PROBE_BYTES=8*1024*1024;
export class VideoExtensionMediaError extends Error{}
export class VideoExtensionToolUnavailableError extends Error{}

type ProbeStream={codec_type?:string;codec_name?:string;width?:number;height?:number;r_frame_rate?:string;avg_frame_rate?:string;sample_aspect_ratio?:string;start_time?:string;duration?:string;side_data_list?:Array<{rotation?:number}>;tags?:{rotate?:string}};
type ProbeFrame={best_effort_timestamp_time?:string};
type StreamProbe={streams?:ProbeStream[];format?:{format_name?:string;duration?:string}};
type FrameProbe={frames?:ProbeFrame[]};
export type NormalizedVideoFacts={width:number;height:number;frameRate:{numerator:number;denominator:number};frameCount:number;timestampDigest:string;hasAudio:boolean;durationSeconds:number;audioSeconds:number|null;container:string;videoCodec:string};

function command(kind:"ffmpeg"|"ffprobe"){return kind==="ffmpeg"?(process.env.FFMPEG_PATH??"ffmpeg"):(process.env.FFPROBE_PATH??"ffprobe");}
async function run(kind:"ffmpeg"|"ffprobe",args:string[],options:{signal?:AbortSignal;timeout?:number;maxBuffer?:number}={}){
  try{return await execute(command(kind),args,{windowsHide:true,timeout:options.timeout??30000,maxBuffer:options.maxBuffer??MAX_PROBE_BYTES,signal:options.signal});}
  catch(error){const value=error as NodeJS.ErrnoException&{killed?:boolean;signal?:string};if(value.code==="ENOENT"||value.code==="EACCES")throw new VideoExtensionToolUnavailableError(`${kind} is unavailable`);if(value.killed||value.signal)throw new VideoExtensionToolUnavailableError(`${kind} did not complete`);throw new VideoExtensionMediaError(`${kind} rejected the media`);}
}
async function toolVersion(kind:"ffmpeg"|"ffprobe",signal?:AbortSignal){const result=await run(kind,["-version"],{signal,timeout:5000,maxBuffer:1024*1024});return String(result.stdout).split(/\r?\n/,1)[0].trim();}
export async function fileSha256AndBytes(filename:string){
  const hash=createHash("sha256");for await(const chunk of createReadStream(filename))hash.update(chunk as Buffer);
  return {sha256:hash.digest("hex"),bytes:(await stat(filename)).size};
}
function timestampDigest(values:number[]){return createHash("sha256").update(values.map(value=>value.toFixed(9)).join("\n")).digest("hex");}
function parseRate(value:string|undefined){if(!value)return null;const [a,b]=value.split("/").map(Number);if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<=0||b<=0)return null;const ratio=a/b;return ratio>=8&&ratio<=60?{numerator:a,denominator:b,ratio}:null;}

export async function inspectNormalizedVideo(filename:string,signal?:AbortSignal):Promise<NormalizedVideoFacts>{
  const [streamsResult,framesResult]=await Promise.all([
    run("ffprobe",["-v","error","-protocol_whitelist","file,pipe","-show_streams","-show_format","-of","json",filename],{signal,timeout:30000}),
    run("ffprobe",["-v","error","-protocol_whitelist","file,pipe","-select_streams","v:0","-show_frames","-show_entries","frame=best_effort_timestamp_time","-of","json",filename],{signal,timeout:60000}),
  ]);
  let streamData:StreamProbe,frameData:FrameProbe;
  try{streamData=JSON.parse(String(streamsResult.stdout));frameData=JSON.parse(String(framesResult.stdout));}catch{throw new VideoExtensionMediaError("FFprobe returned invalid JSON");}
  const streams=streamData.streams??[],videos=streams.filter(stream=>stream.codec_type==="video"),audio=streams.filter(stream=>stream.codec_type==="audio"),other=streams.filter(stream=>!["video","audio"].includes(stream.codec_type??""));
  if(videos.length!==1||audio.length>1||other.length)throw new VideoExtensionMediaError("Video must contain one video stream, at most one audio stream and no other streams");
  const video=videos[0],rotation=Number(video.tags?.rotate??video.side_data_list?.find(item=>item.rotation!==undefined)?.rotation??0);
  if(!video.width||!video.height||!video.codec_name)throw new VideoExtensionMediaError("Video stream metadata is incomplete");
  const rate=parseRate(video.r_frame_rate),average=parseRate(video.avg_frame_rate);
  if(!rate||!average||Math.abs(rate.ratio-average.ratio)>0.05)throw new VideoExtensionMediaError("Video must have a constant frame rate between 8 and 60 FPS");
  if(video.sample_aspect_ratio&&!['1:1','N/A'].includes(video.sample_aspect_ratio))throw new VideoExtensionMediaError("Video must use square pixels");
  if(rotation%360!==0)throw new VideoExtensionMediaError("Video rotation must be baked into the pixels");
  const container=streamData.format?.format_name??"";
  if(!container||/(concat|hls|playlist|image2)/i.test(container)||!/^(mov,mp4|matroska,webm|webm|matroska|mov)/.test(container))throw new VideoExtensionMediaError("Video container is not allowed");
  const timestamps=(frameData.frames??[]).map(frame=>Number(frame.best_effort_timestamp_time));
  if(!timestamps.length||timestamps.length>4800||timestamps.some(value=>!Number.isFinite(value)))throw new VideoExtensionMediaError("Video has an unsupported decoded frame count or timestamps");
  if(Math.abs(timestamps[0])>0.0001)throw new VideoExtensionMediaError("Video timestamps must start at zero");
  const frameSeconds=1/rate.ratio;
  for(let index=1;index<timestamps.length;index++)if(Math.abs((timestamps[index]-timestamps[index-1])-frameSeconds)>Math.max(0.0005,frameSeconds*0.02))throw new VideoExtensionMediaError("Video must use constant zero-based frame timestamps");
  const containerSeconds=Number(streamData.format?.duration),audioDuration=audio.length===1?Number(audio[0].duration??streamData.format?.duration):null;
  return {width:video.width,height:video.height,frameRate:{numerator:rate.numerator,denominator:rate.denominator},frameCount:timestamps.length,timestampDigest:timestampDigest(timestamps),hasAudio:audio.length===1,durationSeconds:Number.isFinite(containerSeconds)&&containerSeconds>0?containerSeconds:timestamps.length*frameSeconds,audioSeconds:audioDuration!==null&&Number.isFinite(audioDuration)?audioDuration:null,container,videoCodec:video.codec_name};
}

export async function inspectVideoSource(filename:string,identity:{sourceAssetId:string;projectId:string},signal?:AbortSignal):Promise<VideoSourceEnvelope>{
  const before=await fileSha256AndBytes(filename),[facts,ffmpegVersion,ffprobeVersion]=await Promise.all([inspectNormalizedVideo(filename,signal),toolVersion("ffmpeg",signal),toolVersion("ffprobe",signal)]),after=await fileSha256AndBytes(filename);
  if(before.sha256!==after.sha256||before.bytes!==after.bytes)throw new VideoExtensionMediaError("Source video changed during inspection");
  return {validationVersion:1,...identity,...before,...facts,ffmpegVersion,ffprobeVersion};
}

export async function videoExtensionReadiness(){
  const missing:string[]=[];let ffmpegVersion:string|undefined,ffprobeVersion:string|undefined;
  try{ffmpegVersion=await toolVersion("ffmpeg");const encoders=await run("ffmpeg",["-hide_banner","-encoders"],{timeout:5000,maxBuffer:1024*1024});if(!/\blibx264\b/.test(String(encoders.stdout)))missing.push("FFmpeg with libx264 encoder");}catch{missing.push("FFmpeg with libx264 encoder");}
  try{ffprobeVersion=await toolVersion("ffprobe");}catch{missing.push("FFprobe");}
  return {state:missing.length?"install_required" as const:"ready" as const,missing:[...new Set(missing)],instructions:"Install FFmpeg with libx264 and FFprobe on the team server, or set FFMPEG_PATH and FFPROBE_PATH to their executables.",versions:{ffmpeg:ffmpegVersion,ffprobe:ffprobeVersion}};
}


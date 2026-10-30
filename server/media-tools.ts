import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {finishingReadiness} from "./finishing-readiness";

const execute=promisify(execFile);
export async function maskedEditReadiness(){
  return finishingReadiness();
}
export type MediaToolchain={ffmpegVersion?:string;ffprobeVersion?:string;libx264:boolean};
function versionLine(output:string,tool:string):string|undefined{
  const line=output.split(/\r?\n/).find(l=>l.toLowerCase().startsWith(`${tool} version`))?.trim();
  return line?line.slice(0,200):undefined;
}
/** Bounded toolchain probe shared by strict media pipelines. Versions are first banner lines only. */
export async function mediaToolchain(signal?:AbortSignal):Promise<MediaToolchain>{
  const result:MediaToolchain={libx264:false};
  const ffmpeg=process.env.FFMPEG_PATH??"ffmpeg",ffprobe=process.env.FFPROBE_PATH??"ffprobe";
  try{result.ffmpegVersion=versionLine(String((await execute(ffmpeg,["-hide_banner","-version"],{timeout:5000,maxBuffer:1024*1024,windowsHide:true,signal})).stdout),"ffmpeg");}catch(e){if(signal?.aborted)throw e;}
  if(result.ffmpegVersion)try{result.libx264=/\blibx264\b/.test(String((await execute(ffmpeg,["-hide_banner","-encoders"],{timeout:5000,maxBuffer:1024*1024,windowsHide:true,signal})).stdout));}catch(e){if(signal?.aborted)throw e;}
  try{result.ffprobeVersion=versionLine(String((await execute(ffprobe,["-hide_banner","-version"],{timeout:5000,maxBuffer:1024*1024,windowsHide:true,signal})).stdout),"ffprobe");}catch(e){if(signal?.aborted)throw e;}
  return result;
}

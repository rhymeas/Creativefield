import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute=promisify(execFile);
export class MediaProbeUnavailableError extends Error{}
/** Probe the actual encoded file before accepting it as a generated video. */
export async function probeVideo(filename:string) {
  let result:Awaited<ReturnType<typeof execute>>;
  try{result=await execute(process.env.FFPROBE_PATH??"ffprobe",["-v","error","-show_streams","-show_format","-of","json",filename],{timeout:15000,maxBuffer:1024*1024,windowsHide:true});}
  catch(error){
    const e=error as NodeJS.ErrnoException&{killed?:boolean;signal?:string};
    if(e.code==="ENOENT"||e.code==="EACCES"||e.killed||e.signal)throw new MediaProbeUnavailableError("Video probe is temporarily unavailable");
    throw new Error("Output is not a decodable video");
  }
  const data=JSON.parse(String(result.stdout)) as {streams?:Array<{codec_type?:string;codec_name?:string;width?:number;height?:number;r_frame_rate?:string}>;format?:{duration?:string;format_name?:string}};
  const video=data.streams?.find(s=>s.codec_type==="video");
  const duration=Number(data.format?.duration);
  if(!video?.width||!video.height||!Number.isFinite(duration)||duration<=0)throw new Error("Output has no valid encoded video stream");
  return {width:video.width,height:video.height,durationSeconds:duration,codec:video.codec_name,frameRate:video.r_frame_rate,hasAudio:data.streams?.some(s=>s.codec_type==="audio")??false,container:data.format?.format_name};
}

import {execFile} from "node:child_process";
import {mkdtemp, mkdir, rm} from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";

const execute=promisify(execFile);

/** Give a silent source an audio stream in a disposable upload copy. */
export async function withVideoAudio<T>(source:string, use:(file:string)=>Promise<T>, optionsForSource:{padTail?:boolean}={}):Promise<T>{
  const options={timeout:30000,maxBuffer:1024*1024,windowsHide:true};
  const probe=await execute(process.env.FFPROBE_PATH??"ffprobe",["-v","error","-protocol_whitelist","file,pipe","-select_streams","a:0","-show_entries","stream=index","-of","json",source],options);
  const streams=(JSON.parse(probe.stdout) as {streams?:unknown[]}).streams;
  if(!Array.isArray(streams))throw new Error("Could not inspect the video audio stream");
  if(streams.length&&!optionsForSource.padTail)return use(source);
  const root=path.resolve(process.cwd(),".comfyfield","tmp");
  await mkdir(root,{recursive:true});
  const dir=await mkdtemp(path.join(root,"silent-audio-"));
  try{
    const output=path.join(dir,"source.mkv");
    const audio=streams.length?["-map","0:v:0","-map","0:a:0","-c:v","copy","-af","apad=pad_dur=0.25","-c:a","aac"]:["-f","lavfi","-i","anullsrc=channel_layout=stereo:sample_rate=48000","-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac","-shortest"];
    await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-protocol_whitelist","file,pipe","-i",source,...audio,output],{...options,timeout:300000});
    return await use(output);
  }finally{await rm(dir,{recursive:true,force:true});}
}

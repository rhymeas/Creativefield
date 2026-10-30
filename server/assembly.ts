import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdir,mkdtemp,writeFile,readdir,unlink,rmdir,realpath,lstat,stat} from "node:fs/promises";
import {createReadStream} from "node:fs";
import path from "node:path";
import {z} from "zod";
import type {DiskStore} from "./storage";
import {probeVideo} from "./media";
import {finishingReadiness} from "./finishing-readiness";

const execute=promisify(execFile);
const even=z.number().int().min(64).max(1920).refine(n=>n%2===0);
/** Joins are hard cuts unless asked otherwise: a cross-fade costs a re-encode and shortens the film
 *  by the overlap, so it has to be a deliberate choice rather than a default change. */
export const transitionSchema=z.object({kind:z.enum(["cut","crossfade"]),seconds:z.number().min(0.1).max(2)}).strict();
export const assemblySchema=z.object({width:even,height:even,fps:z.union([z.literal(24),z.literal(25),z.literal(30),z.literal(60)]),audioPolicy:z.enum(["mute","preserve"]),transition:transitionSchema.optional()}).strict();
export type AssemblySettings=z.infer<typeof assemblySchema>;
export type AssemblyClip={key:string;frames:number};
export class AssemblyError extends Error{}

export async function assemblyReadiness(){
  return finishingReadiness(true);
}

async function frameCount(file:string,signal:AbortSignal){
  const result=await execute(process.env.FFPROBE_PATH??"ffprobe",["-v","error","-protocol_whitelist","file,pipe","-select_streams","v:0","-count_frames","-show_entries","stream=nb_read_frames","-of","json",file],{timeout:30000,maxBuffer:1024*1024,windowsHide:true,signal});
  return Number(JSON.parse(result.stdout).streams?.[0]?.nb_read_frames);
}

/** Hard cuts with normalized, frame-counted segments. Accepts only resolved disk keys. */
export async function assembleVideo(store:DiskStore,workspaceId:string,clips:AssemblyClip[],input:AssemblySettings,cancel:AbortSignal){
  const settings=assemblySchema.parse(input);
  if(!clips.length||clips.length>32||clips.some(c=>!Number.isSafeInteger(c.frames)||c.frames<1)||clips.reduce((n,c)=>n+c.frames/settings.fps,0)>300)throw new AssemblyError("Unsupported storyboard timing");
  const signal=AbortSignal.any([cancel,AbortSignal.timeout(10*60*1000)]);
  const root=path.join(store.root,".assembly");await mkdir(root,{recursive:true});
  if((await lstat(root)).isSymbolicLink())throw new AssemblyError("Invalid assembly scratch directory");
  const resolved=await realpath(root),dir=await mkdtemp(path.join(resolved,"attempt-"));
  const run=async(args:string[])=>execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y",...args],{timeout:120000,maxBuffer:1024*1024,windowsHide:true,signal});
  let candidate:Awaited<ReturnType<DiskStore["put"]>>|undefined;
  try{
    let scratchBytes=0;
    for(const [index,clip] of clips.entries()){
      signal.throwIfAborted();
      const source=await store.file(workspaceId,clip.key),info=await probeVideo(source),seconds=clip.frames/settings.fps;
      if(info.durationSeconds+1/settings.fps<seconds)throw new AssemblyError(`Shot ${index+1} is shorter than its requested duration`);
      const target=path.join(dir,`segment-${index}.mp4`),args=["-protocol_whitelist","file,pipe","-i",source];
      const v=`[0:v:0]setpts=PTS-STARTPTS,fps=${settings.fps},scale=${settings.width}:${settings.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${settings.width}:${settings.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,trim=end_frame=${clip.frames},setpts=PTS-STARTPTS[v]`;
      let filter=v;
      if(settings.audioPolicy==="preserve"){
        if(!info.hasAudio)args.push("-f","lavfi","-i","anullsrc=r=48000:cl=stereo");
        filter+=`;[${info.hasAudio?"0:a:0":"1:a:0"}]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${seconds},asetpts=N/SR/TB[a]`;
      }
      args.push("-filter_complex_threads","1","-filter_complex",filter,"-map","[v]");
      if(settings.audioPolicy==="preserve")args.push("-map","[a]","-c:a","aac","-ar","48000","-ac","2");else args.push("-an");
      args.push("-c:v","libx264","-threads","2","-preset","veryfast","-crf","20","-pix_fmt","yuv420p","-t",String(seconds),"-map_metadata","-1","-fs",String(store.maxBytes+1),target);
      await run(args);
      scratchBytes+=(await stat(target)).size;
      if(scratchBytes>store.maxBytes)throw new AssemblyError("Storyboard exceeds assembly scratch limit; shorten the sequence or raise MAX_UPLOAD_MB");
      if(await frameCount(target,signal)!==clip.frames)throw new AssemblyError(`Shot ${index+1} has insufficient decoded frames for its requested duration`);
    }
    await writeFile(path.join(dir,"segments.txt"),clips.map((_,i)=>`file 'segment-${i}.mp4'`).join("\n"));
    const output=path.join(dir,"assembled.mp4");
    const transition=settings.transition??{kind:"cut" as const,seconds:0};
    const fade=transition.kind==="crossfade"?transition.seconds:0;
    /* A cross-fade overlaps neighbours, so the sequence gets shorter by (n-1) × fade and cannot be
       stream-copied — the joins are decoded, blended and re-encoded. */
    const overlapFrames=fade>0?Math.round(fade*settings.fps)*(clips.length-1):0;
    const expectedFrames=clips.reduce((n,c)=>n+c.frames,0)-overlapFrames;
    if(fade>0){
      if(clips.length<2)throw new AssemblyError("A cross-fade needs at least two shots");
      const shortest=Math.min(...clips.map(c=>c.frames))/settings.fps;
      if(fade>=shortest)throw new AssemblyError(`A ${fade}s cross-fade is longer than the shortest shot (${shortest.toFixed(2)}s)`);
      const args=["-protocol_whitelist","file,pipe"];
      for(let i=0;i<clips.length;i++)args.push("-i",path.join(dir,`segment-${i}.mp4`));
      const chain:string[]=[];let video="[0:v:0]",audio=settings.audioPolicy==="preserve"?"[0:a:0]":null;
      let elapsed=clips[0].frames/settings.fps;
      for(let i=1;i<clips.length;i++){
        const offset=(elapsed-fade).toFixed(3);
        chain.push(`${video}[${i}:v:0]xfade=transition=fade:duration=${fade}:offset=${offset}[v${i}]`);
        video=`[v${i}]`;
        if(audio)chain.push(`${audio}[${i}:a:0]acrossfade=d=${fade}:c1=tri:c2=tri[a${i}]`),audio=`[a${i}]`;
        elapsed=elapsed+clips[i].frames/settings.fps-fade;
      }
      args.push("-filter_complex_threads","1","-filter_complex",chain.join(";"),"-map",video);
      if(audio)args.push("-map",audio,"-c:a","aac","-ar","48000","-ac","2");else args.push("-an");
      args.push("-c:v","libx264","-threads","2","-preset","veryfast","-crf","20","-pix_fmt","yuv420p","-map_metadata","-1","-movflags","+faststart","-fs",String(store.maxBytes+1),output);
      await run(args);
    }else{
      await run(["-protocol_whitelist","file,pipe","-f","concat","-safe","1","-i",path.join(dir,"segments.txt"),"-map","0:v:0",...(settings.audioPolicy==="preserve"?["-map","0:a:0"]:["-an"]),"-c","copy","-map_metadata","-1","-movflags","+faststart","-fs",String(store.maxBytes+1),output]);
    }
    const metadata=await probeVideo(output),frames=await frameCount(output,signal);
    /* Hard cuts are exact: every frame of every shot, nothing lost. A cross-fade trims each join at
       the offset, so allow a frame or two of rounding there and verify the duration too. */
    const frameTolerance=fade>0?Math.max(2,Math.ceil(settings.fps*0.12)):0;
    const durationTolerance=fade>0?0.25:0.12;
    if(Math.abs(frames-expectedFrames)>frameTolerance||metadata.width!==settings.width||metadata.height!==settings.height||Math.abs(metadata.durationSeconds-expectedFrames/settings.fps)>durationTolerance||metadata.hasAudio!==(settings.audioPolicy==="preserve"))throw new AssemblyError("Assembly output timing or media verification failed");
    signal.throwIfAborted();candidate=await store.put(workspaceId,createReadStream(output));
    return {...candidate,metadata:{...metadata,frames,requestedDurationSeconds:expectedFrames/settings.fps,assembly:settings}};
  }catch(e){
    if(candidate)await store.remove(workspaceId,candidate.key).catch(()=>{});
    if(e instanceof AssemblyError)throw e;
    if(signal.aborted)throw new AssemblyError("Assembly interrupted or timed out; generated shots are preserved");
    throw new AssemblyError("Assembly failed; check FFmpeg, FFprobe, source media and disk capacity");
  }finally{
    // Delete only regular files in the private directory created by this attempt.
    if(path.dirname(await realpath(dir))===resolved){
      for(const entry of await readdir(dir,{withFileTypes:true}))if(entry.isFile())await unlink(path.join(dir,entry.name));
      await rmdir(dir);
    }
  }
}

import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createReadStream} from "node:fs";
import {mkdtemp, mkdir, unlink, rmdir} from "node:fs/promises";
import path from "node:path";
import {assembleVideo} from "./assembly";
import {probeVideo} from "./media";
import type {DiskStore} from "./storage";
import type {SwapSegment} from "./openjutsu-orchestration";

const execute=promisify(execFile);

/** Assemble verified source-frame intervals, then attach the source audio once across
 * the complete timeline. Segment audio is deliberately ignored. All paths originate
 * from DiskStore; this operation never overwrites the source or any generated shot. */
export async function assembleOpenJutsuSegments(store:DiskStore,workspaceId:string,args:{segments:SwapSegment[];originalAudioSource:string;frameCount:number;fps:24;width:number;height:number;signal:AbortSignal}) {
  let cursor=0;
  for(const segment of args.segments){
    if(segment.sourceStart!==cursor||segment.sourceEnd<=cursor)throw new Error("OpenJutsu segments do not cover the source timeline.");
    cursor=segment.sourceEnd;
  }
  if(cursor!==args.frameCount)throw new Error("OpenJutsu segments do not cover the source timeline.");
  const source=await store.file(workspaceId,args.originalAudioSource);
  const sourceInfo=await probeVideo(source);
  const assembled=await assembleVideo(store,workspaceId,args.segments.map(segment=>({key:segment.output,startFrame:segment.outputStart,frames:segment.sourceEnd-segment.sourceStart})),{width:args.width,height:args.height,fps:args.fps,audioPolicy:"mute"},args.signal);
  // A silent source remains silent. Do not manufacture audio or label it as speech.
  if(!sourceInfo.hasAudio)return {output:assembled.key,frames:args.frameCount,audioSource:args.originalAudioSource};
  let output:string|undefined;
  const root=path.join(store.root,".openjutsu-assembly");
  try {
    await mkdir(root,{recursive:true});
    const dir=await mkdtemp(path.join(root,"mux-"));
    output=path.join(dir,"output.mp4");
    try{
      await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-protocol_whitelist","file,pipe","-i",await store.file(workspaceId,assembled.key),"-protocol_whitelist","file,pipe","-i",source,"-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac","-af",`apad,atrim=duration=${args.frameCount/args.fps}`,"-t",String(args.frameCount/args.fps),"-map_metadata","-1","-movflags","+faststart",output],{windowsHide:true,timeout:120000,maxBuffer:1024*1024,signal:args.signal});
      const info=await probeVideo(output);
      if(!info.hasAudio||Math.abs(info.durationSeconds-args.frameCount/args.fps)>0.12)throw new Error("OpenJutsu audio assembly timing failed.");
      const result=await store.put(workspaceId,createReadStream(output));
      return {output:result.key,frames:args.frameCount,audioSource:args.originalAudioSource};
    }finally{if(output)await unlink(output).catch(()=>{});await rmdir(dir).catch(()=>{});}
  }finally{await store.remove(workspaceId,assembled.key).catch(()=>{});}
}

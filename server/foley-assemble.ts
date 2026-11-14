import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {ffmpegPath,probeMedia,runTool,streamDuration,streamsOfType} from './audio-processing-validation';
import {planFoleyWindows} from './foley-timeline';

/** Combine generated window audio with the original video in a temporary MP4.
 * The callback must consume the file before returning. Original inputs are untouched. */
export async function withFoleyVideo<T>(video:string,audioFiles:readonly string[],durationSeconds:number,consume:(file:string)=>Promise<T>,signal?:AbortSignal):Promise<T>{
 const windows=planFoleyWindows(durationSeconds);
 if(audioFiles.length!==windows.length||windows.length>500)throw new Error('The audio segments do not match the video timeline.');
 const sourceInfo=await probeMedia(video,'video',signal),sourceVideo=streamsOfType(sourceInfo,'video')[0];
 if(!sourceVideo||Math.abs(streamDuration(sourceVideo,sourceInfo)-durationSeconds)>0.05)throw new Error('The video duration does not match the planned timeline.');
 // ControlFoley measures source duration to the last frame timestamp, which can
 // be one frame shorter than the container's duration. Pad only that small tail.
 const durationTolerance=0.05+(sourceVideo.frameRate?1/sourceVideo.frameRate:0);
 for(const [index,file] of audioFiles.entries()){
  const info=await probeMedia(file,'audio',signal),stream=streamsOfType(info,'audio')[0];
  if(!stream||streamDuration(stream,info)+durationTolerance<(windows[index].endMs-windows[index].startMs)/1000)throw new Error(`Audio segment ${index+1} is shorter than its video segment.`);
 }
 const root=path.resolve(process.cwd(),'.comfyfield','tmp');await mkdir(root,{recursive:true});
 const dir=await mkdtemp(path.join(root,'foley-assemble-'));
 try{
  const output=path.join(dir,'result.mp4'),args=['-hide_banner','-loglevel','error','-nostdin','-y','-i',video];
  for(const file of audioFiles)args.push('-i',file);
  const filters=windows.map((w,index)=>`[${index+1}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${(w.endMs-w.startMs)/1000},asetpts=PTS-STARTPTS[a${index}]`);
  filters.push(`${windows.map((_,index)=>`[a${index}]`).join('')}concat=n=${windows.length}:v=0:a=1[out]`);
  args.push('-filter_complex',filters.join(';'),'-map','0:v:0','-map','[out]','-map_metadata','0','-c:v','copy','-c:a','aac','-t',String(windows.at(-1)!.endMs/1000),'-movflags','+faststart',output);
  await runTool(ffmpegPath(),args,signal);return await consume(output);
 }finally{await rm(dir,{recursive:true,force:true});}
}

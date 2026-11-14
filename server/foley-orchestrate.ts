import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {ffmpegPath,probeMedia,runTool,streamDuration,streamsOfType} from './audio-processing-validation';
import {withFoleyVideo} from './foley-assemble';
import {planFoleyWindows} from './foley-timeline';

/** Generate sound once for a selected excerpt and return that excerpt with its sound. */
export async function withGeneratedFoleyExcerpt<T>(video:string,startSeconds:number,durationSeconds:number,generate:(segment:string,audioDestination:string,signal?:AbortSignal)=>Promise<void>,consume:(video:string)=>Promise<T>,signal?:AbortSignal):Promise<T>{
 if(!Number.isFinite(startSeconds)||startSeconds<0||!Number.isFinite(durationSeconds)||durationSeconds<0.7||durationSeconds>30)throw new Error('Choose an excerpt between 0.7 and 30 seconds.');
 const info=await probeMedia(video,'video',signal),stream=streamsOfType(info,'video')[0];
 if(!stream)throw new Error('The source has no video stream.');
 const sourceDuration=streamDuration(stream,info);
 if(startSeconds+durationSeconds>sourceDuration+0.001)throw new Error('The selected excerpt extends beyond the video.');
 const root=path.resolve(process.cwd(),'.comfyfield','tmp');await mkdir(root,{recursive:true});
 const dir=await mkdtemp(path.join(root,'foley-excerpt-'));
 try{
  const clip=path.join(dir,'clip.mp4'),audio=path.join(dir,'audio.wav');
  // H.264/yuv420p needs even dimensions. Add at most one pixel at the right
  // and bottom instead of cropping or stretching the user's image.
  // At fractional frame rates, -t 30 alone can produce a clip slightly over
  // 30 seconds. Cap at the last whole frame that fits the model's limit.
  const maxFrames=stream.frameRate?Math.floor(30*stream.frameRate+1e-7):undefined;
  await runTool(ffmpegPath(),['-hide_banner','-loglevel','error','-nostdin','-y','-i',video,'-ss',String(startSeconds),'-t',String(durationSeconds),'-map','0:v:0','-an','-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p',...(maxFrames?['-frames:v',String(maxFrames)]:[]),clip],signal);
  const clipInfo=await probeMedia(clip,'video',signal),clipStream=streamsOfType(clipInfo,'video')[0];
  if(!clipStream)throw new Error('The selected excerpt contains no video.');
  const clipDuration=streamDuration(clipStream,clipInfo);
  if(clipDuration<0.7||clipDuration>30)throw new Error('The encoded excerpt must be between 0.7 and 30 seconds.');
  await generate(clip,audio,signal);
  return await withFoleyVideo(clip,[audio],clipDuration,consume,signal);
 }finally{await rm(dir,{recursive:true,force:true});}
}

/** Prepare each source window, ask the caller to generate its audio, then join it.
 * The caller writes each generated audio file to the supplied destination. */
export async function withGeneratedFoley<T>(video:string,generate:(segment:string,audioDestination:string,index:number,signal?:AbortSignal)=>Promise<void>,consume:(video:string)=>Promise<T>,signal?:AbortSignal):Promise<T>{
 const info=await probeMedia(video,'video',signal),stream=streamsOfType(info,'video')[0];
 if(!stream)throw new Error('The source has no video stream.');
 const duration=streamDuration(stream,info),windows=planFoleyWindows(duration);
 if(windows.length>500)throw new Error('The video has too many sound segments.');
 const root=path.resolve(process.cwd(),'.comfyfield','tmp');await mkdir(root,{recursive:true});
 const dir=await mkdtemp(path.join(root,'foley-generate-'));
 try{
  const audioFiles:string[]=[];
  for(const [index,window] of windows.entries()){
   const clip=path.join(dir,`clip-${index}.mp4`),audio=path.join(dir,`audio-${index}.wav`);
   await runTool(ffmpegPath(),['-hide_banner','-loglevel','error','-nostdin','-y','-i',video,'-ss',String(window.startMs/1000),'-t',String((window.endMs-window.startMs)/1000),'-map','0:v:0','-an','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p',clip],signal);
   await generate(clip,audio,index,signal);audioFiles.push(audio);
  }
  return await withFoleyVideo(video,audioFiles,duration,consume,signal);
 }finally{await rm(dir,{recursive:true,force:true});}
}

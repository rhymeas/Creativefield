import {execFile} from 'node:child_process';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,mkdtemp,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {promisify} from 'node:util';
import type {OwnedInput} from './types';

const execute=promisify(execFile);

/** Prepare a bounded, temporary upload copy; never modify the project asset. */
export async function withH3Video<T>(input:OwnedInput,upload:(video:OwnedInput)=>Promise<T>):Promise<T>{
 const root=path.resolve(process.cwd(),'.comfyfield','tmp');
 await mkdir(root,{recursive:true});
 const dir=await mkdtemp(path.join(root,'h3-video-'));
 try{
  const source=path.join(dir,'source'),output=path.join(dir,'ready.mp4');
  await pipeline(await input.open(),createWriteStream(source,{flags:'wx'}));
  const probe=await execute(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=duration:format=duration','-of','json',source],{timeout:30000,maxBuffer:1024*1024,windowsHide:true});
  const facts=JSON.parse(probe.stdout) as {streams?:Array<{duration?:string}>;format?:{duration?:string}};
  const streamDuration=Number(facts.streams?.[0]?.duration),formatDuration=Number(facts.format?.duration);
  const duration=Number.isFinite(streamDuration)&&streamDuration>0?streamDuration:formatDuration;
  if(!Number.isFinite(duration)||duration<=0)throw new Error('The video duration could not be read.');
  const outputDuration=Math.max(2,Math.min(15,duration));
  await execute(process.env.FFMPEG_PATH??'ffmpeg',[
   '-hide_banner','-loglevel','error','-nostdin','-y','-protocol_whitelist','file,pipe',
   '-i',source,'-t',String(outputDuration),'-map','0:v:0','-an','-sn','-dn',
   // Keep large inputs bounded while preserving their proportions. Extremely wide or
   // tall clips need padding after scaling to satisfy the minimum on both sides.
   '-vf',"scale='max(2,ceil(iw*min(1920/max(iw,ih),max(1,256/min(iw,ih)))/2)*2)':'max(2,ceil(ih*min(1920/max(iw,ih),max(1,256/min(iw,ih)))/2)*2)',pad='max(256,iw)':'max(256,ih)':(ow-iw)/2:(oh-ih)/2:black,fps=24,tpad=stop_mode=clone:stop_duration=2",
   '-c:v','libx264','-preset','veryfast','-crf','23','-maxrate','20M','-bufsize','40M',
   '-pix_fmt','yuv420p','-movflags','+faststart',output
  ],{timeout:300000,maxBuffer:1024*1024,windowsHide:true});
  const size=(await stat(output)).size;
  if(!size||size>100*1024*1024)throw new Error('The video could not be prepared within the H3 size limit.');
  return await upload({role:input.role,contentType:'video/mp4',bytes:size,open:async()=>createReadStream(output)});
 }finally{await rm(dir,{recursive:true,force:true});}
}

/** A temporary copy cut to the first `maxSeconds`, for models with a length limit (Kling: 10 s); shorter clips go as they are. */
export async function withVideoCut<T>(input:OwnedInput,maxSeconds:number,upload:(video:OwnedInput)=>Promise<T>):Promise<T>{
 const root=path.resolve(process.cwd(),'.comfyfield','tmp');
 await mkdir(root,{recursive:true});
 const dir=await mkdtemp(path.join(root,'video-cut-'));
 try{
  const source=path.join(dir,'source'),output=path.join(dir,'cut.mp4');
  await pipeline(await input.open(),createWriteStream(source,{flags:'wx'}));
  /* A length that cannot be read is left to the model's own check: the file goes as it is. */
  const duration=await execute(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-show_entries','format=duration','-of','json',source],{timeout:30000,maxBuffer:1024*1024,windowsHide:true}).then(probe=>Number((JSON.parse(probe.stdout) as {format?:{duration?:string}}).format?.duration),()=>NaN);
  if(!Number.isFinite(duration)||duration<=maxSeconds+0.05)return await upload({...input,open:async()=>createReadStream(source)});
  await execute(process.env.FFMPEG_PATH??'ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-protocol_whitelist','file,pipe','-i',source,'-t',String(maxSeconds),'-map','0:v:0','-map','0:a?','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',output],{timeout:300000,maxBuffer:1024*1024,windowsHide:true});
  const size=(await stat(output)).size;
  if(!size)throw new Error('The video could not be cut to length.');
  return await upload({role:input.role,contentType:'video/mp4',bytes:size,open:async()=>createReadStream(output)});
 }finally{await rm(dir,{recursive:true,force:true});}
}

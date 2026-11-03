import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe,expect,it} from 'vitest';
import {probeMedia,streamsOfType,streamDuration} from '../server/audio-processing-validation';
import {withFoleyVideo} from '../server/foley-assemble';

describe('Foley video assembly',()=>{
 it('accepts one missing frame of generated audio but rejects a larger gap',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'foley-tail-')),ffmpeg=process.env.FFMPEG_PATH??'ffmpeg';
  try{
   const video=path.join(dir,'video.mp4'),near=path.join(dir,'near.wav'),short=path.join(dir,'short.wav');
   execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=blue:size=32x32:rate=10:duration=2','-c:v','libx264','-y',video]);
   for(const [file,duration] of [[near,1.9],[short,1.7]] as const)execFileSync(ffmpeg,['-v','error','-f','lavfi','-i',`sine=frequency=440:duration=${duration}`,'-y',file]);
   const info=await probeMedia(video,'video');expect(streamsOfType(info,'video')[0].frameRate).toBe(10);
   await withFoleyVideo(video,[near],2,async output=>{const result=await probeMedia(output,'video');expect(streamDuration(streamsOfType(result,'audio')[0],result)).toBeCloseTo(2,1);});
   await expect(withFoleyVideo(video,[short],2,async()=>undefined)).rejects.toThrow('shorter');
  }finally{await rm(dir,{recursive:true,force:true});}
 },30000);
 it('joins two generated audio windows to the full original video',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'foley-assembly-'));
  try{
   const video=path.join(dir,'video.mp4'),first=path.join(dir,'first.wav'),second=path.join(dir,'second.wav'),ffmpeg=process.env.FFMPEG_PATH??'ffmpeg';
   execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=blue:size=32x32:rate=10:duration=30.2','-c:v','libx264','-y',video]);
   for(const [file,frequency] of [[first,440],[second,880]] as const)execFileSync(ffmpeg,['-v','error','-f','lavfi','-i',`sine=frequency=${frequency}:duration=15.1`,'-y',file]);
   const before=(await stat(video)).size;
   await withFoleyVideo(video,[first,second],30.2,async output=>{
    const info=await probeMedia(output,'video'),v=streamsOfType(info,'video')[0],a=streamsOfType(info,'audio')[0];
    expect(v.codecName).toBe('h264');expect(streamDuration(v,info)).toBeCloseTo(30.2,1);expect(streamDuration(a,info)).toBeCloseTo(30.2,1);
   });
   expect((await stat(video)).size).toBe(before);
   await expect(withFoleyVideo(video,[first],30.2,async()=>undefined)).rejects.toThrow('segments');
  }finally{await rm(dir,{recursive:true,force:true});}
 },30000);
});

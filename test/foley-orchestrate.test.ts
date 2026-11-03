import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe,expect,it} from 'vitest';
import {probeMedia,streamDuration,streamsOfType} from '../server/audio-processing-validation';
import {withGeneratedFoley,withGeneratedFoleyExcerpt} from '../server/foley-orchestrate';
import {withWorkerFoleyExcerpt} from '../server/foley-worker';

describe('Foley segment orchestration',()=>{
 it('accepts a 30-second excerpt from a fractional-frame-rate video',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'foley-ntsc-')),ffmpeg=process.env.FFMPEG_PATH??'ffmpeg';
  try{
   const video=path.join(dir,'source.mp4');execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=32x32:rate=30000/1001:duration=31','-c:v','libx264','-y',video]);
   let calls=0;
   await withGeneratedFoleyExcerpt(video,0,30,async(clip,audio)=>{calls++;const info=await probeMedia(clip,'video'),duration=streamDuration(streamsOfType(info,'video')[0],info);expect(duration).toBeLessThanOrEqual(30);expect(duration).toBeGreaterThan(29.9);execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=30','-y',audio]);},async output=>{
    const info=await probeMedia(output,'video');expect(streamsOfType(info,'audio')).toHaveLength(1);
   });
   expect(calls).toBe(1);
  }finally{await rm(dir,{recursive:true,force:true});}
 },30000);
 it('prepares an odd-sized video excerpt without cropping its image',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'foley-odd-')),ffmpeg=process.env.FFMPEG_PATH??'ffmpeg';
  try{
   const video=path.join(dir,'source.mkv');execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc=size=321x241:rate=10:duration=2','-c:v','ffv1','-y',video]);
   await withGeneratedFoleyExcerpt(video,0,2,async(clip,audio)=>{
    const info=await probeMedia(clip,'video'),stream=streamsOfType(info,'video')[0];
    expect(stream.width).toBe(322);expect(stream.height).toBe(242);
    execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=2','-y',audio]);
   },async output=>{
    const info=await probeMedia(output,'video');expect(streamsOfType(info,'audio')).toHaveLength(1);
    const frame=streamsOfType(info,'video')[0];expect(frame.width).toBe(322);expect(frame.height).toBe(242);
   });
  }finally{await rm(dir,{recursive:true,force:true});}
 },30000);
 it('passes a single excerpt and prompt through the worker adapter',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'foley-worker-test-')),ffmpeg=process.env.FFMPEG_PATH??'ffmpeg';
  try{
   const video=path.join(dir,'source.mp4');execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=32x32:rate=10:duration=4','-c:v','libx264','-y',video]);
   const worker={upload:async(clip:string)=>{const info=await probeMedia(clip,'video');expect(streamDuration(streamsOfType(info,'video')[0],info)).toBeCloseTo(2,1);return 'comfyfield-test.mp4';},run:async(graph:Record<string,any>,key:string,destination:string)=>{expect(key).toBe('foley:job-1:0');expect(graph['3'].inputs.prompt).toBe('Rain on a roof');expect(graph['3'].inputs.seed).toBe(42);execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=2','-y',destination]);}};
   await withWorkerFoleyExcerpt(worker,'job-1','Rain on a roof',42,video,1,2,async output=>{const info=await probeMedia(output,'video');expect(streamDuration(streamsOfType(info,'audio')[0],info)).toBeCloseTo(2,1);});
  }finally{await rm(dir,{recursive:true,force:true});}
 },30000);
 it('generates once for the selected excerpt and rejects a window beyond the source',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'foley-excerpt-test-')),ffmpeg=process.env.FFMPEG_PATH??'ffmpeg';
  try{
   const video=path.join(dir,'source.mp4');execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=32x32:rate=10:duration=4','-c:v','libx264','-y',video]);
   let calls=0;
   await withGeneratedFoleyExcerpt(video,1,2,async(clip,audio)=>{
    calls++;const info=await probeMedia(clip,'video');expect(streamDuration(streamsOfType(info,'video')[0],info)).toBeCloseTo(2,1);
    execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=2','-y',audio]);
   },async output=>{const info=await probeMedia(output,'video');expect(streamDuration(streamsOfType(info,'audio')[0],info)).toBeCloseTo(2,1);});
   expect(calls).toBe(1);
   await expect(withGeneratedFoleyExcerpt(video,3,2,async()=>{calls++;},async()=>undefined)).rejects.toThrow('beyond the video');
   await expect(withGeneratedFoleyExcerpt(video,0,30.1,async()=>{calls++;},async()=>undefined)).rejects.toThrow('30 seconds');
   expect(calls).toBe(1);
  }finally{await rm(dir,{recursive:true,force:true});}
 },30000);
 it('sends consecutive source clips to generation and joins the resulting tracks',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'foley-run-')),ffmpeg=process.env.FFMPEG_PATH??'ffmpeg';
  try{
   const video=path.join(dir,'source.mp4');execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=32x32:rate=10:duration=30.2','-c:v','libx264','-y',video]);
   const lengths:number[]=[];
   await withGeneratedFoley(video,async(clip,destination,index)=>{
    const info=await probeMedia(clip,'video'),length=streamDuration(streamsOfType(info,'video')[0],info);lengths.push(length);
    execFileSync(ffmpeg,['-v','error','-f','lavfi','-i',`sine=frequency=${index?880:440}:duration=15.1`,'-y',destination]);
   },async output=>{
    const info=await probeMedia(output,'video');expect(streamDuration(streamsOfType(info,'audio')[0],info)).toBeCloseTo(30.2,1);
    // Count zero crossings in decoded PCM to establish which tone lands on each side.
    const crossings=(at:number)=>{const pcm=execFileSync(ffmpeg,['-v','error','-ss',String(at),'-i',output,'-t','0.1','-ac','1','-ar','48000','-f','f32le','-']);let count=0,previous=pcm.readFloatLE(0);for(let offset=4;offset<pcm.length;offset+=4){const sample=pcm.readFloatLE(offset);if(previous<=0&&sample>0)count++;previous=sample;}return count;};
    const first=crossings(5),second=crossings(20);
    expect(first).toBeGreaterThan(40);expect(first).toBeLessThan(48);
    expect(second).toBeGreaterThan(84);expect(second).toBeLessThan(92);
   });
   expect(lengths).toHaveLength(2);expect(lengths[0]).toBeCloseTo(15.1,1);expect(lengths[1]).toBeCloseTo(15.1,1);
  }finally{await rm(dir,{recursive:true,force:true});}
 },30000);
});

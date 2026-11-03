import {execFileSync} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe,expect,it} from 'vitest';
import {withH3Video} from '../server/providers/h3-video';

describe('H3 video preparation',()=>{
 it('keeps the original audio-bearing asset intact while the reference derivative is silent',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'h3-audio-contract-'));
  try{
   const source=path.join(dir,'source-with-audio.mp4'),ffmpeg=process.env.FFMPEG_PATH??'ffmpeg',ffprobe=process.env.FFPROBE_PATH??'ffprobe';
   execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=green:size=320x240:rate=24:duration=2','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-map','0:v:0','-map','1:a:0','-c:v','libx264','-c:a','aac','-shortest','-y',source]);
   const before=(await stat(source)).size,streams=(file:string)=>JSON.parse(execFileSync(ffprobe,['-v','error','-show_entries','stream=codec_type','-of','json',file],{encoding:'utf8'})).streams.map((stream:{codec_type:string})=>stream.codec_type);
   expect(streams(source)).toEqual(['video','audio']);
   await withH3Video({role:'source_video',contentType:'video/mp4',bytes:before,open:async()=>createReadStream(source)},async ready=>{
    const file=(await ready.open() as ReturnType<typeof createReadStream>).path.toString();
    expect(streams(file)).toEqual(['video']);
   });
   expect((await stat(source)).size).toBe(before);expect(streams(source)).toEqual(['video','audio']);
  }finally{await rm(dir,{recursive:true,force:true});}
 },30000);
 it('bounds and pads an unusually wide video without stretching it',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'h3-wide-'));
  try{
   const source=path.join(dir,'wide.mp4');
   execFileSync(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-f','lavfi','-i','color=red:size=2400x200:rate=8:duration=2','-c:v','libx264','-y',source]);
   await withH3Video({role:'source_video',contentType:'video/mp4',bytes:(await stat(source)).size,open:async()=>createReadStream(source)},async ready=>{
    const file=(await ready.open() as ReturnType<typeof createReadStream>).path.toString();
    const info=JSON.parse(execFileSync(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',file],{encoding:'utf8'}));
    expect(info.streams[0]).toMatchObject({width:1920,height:256});
    const pixel=(x:number,y:number)=>execFileSync(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-i',file,'-vf',`format=rgb24,crop=1:1:${x}:${y}`,'-frames:v','1','-f','rawvideo','pipe:1']);
    expect(pixel(960,0)[0]).toBeLessThan(20);
    expect(pixel(960,128)[0]).toBeGreaterThan(200);
   });
  }finally{await rm(dir,{recursive:true,force:true});}
 },30000);
 it('honors rotation metadata in phone videos',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'h3-rotation-'));
  try{
   const raw=path.join(dir,'raw.mp4'),source=path.join(dir,'rotated.mov'),ffmpeg=process.env.FFMPEG_PATH??'ffmpeg';
   execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=blue:size=320x180:rate=24:duration=2','-c:v','libx264','-y',raw]);
   execFileSync(ffmpeg,['-v','error','-display_rotation:v:0','90','-i',raw,'-c','copy','-y',source]);
   const inputInfo=JSON.parse(execFileSync(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream_side_data=rotation','-of','json',source],{encoding:'utf8'}));
   expect(inputInfo.streams[0].side_data_list[0].rotation).toBe(90);
   await withH3Video({role:'source_video',contentType:'video/quicktime',bytes:(await stat(source)).size,open:async()=>createReadStream(source)},async ready=>{
    const file=(await ready.open() as ReturnType<typeof createReadStream>).path.toString();
    const result=JSON.parse(execFileSync(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',file],{encoding:'utf8'}));
    expect(result.streams[0].height).toBeGreaterThan(result.streams[0].width);
    expect(result.streams[0].width).toBeGreaterThanOrEqual(256);
   });
  }finally{await rm(dir,{recursive:true,force:true});}
 },30000);
 it('converts a portrait MOV and keeps its original file intact',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'h3-mov-'));
  try{
   const source=path.join(dir,'portrait.mov'),ffmpeg=process.env.FFMPEG_PATH??'ffmpeg';
   execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=blue:size=180x320:rate=12:duration=3','-c:v','mpeg4','-y',source]);
   const before=(await stat(source)).size;
   await withH3Video({role:'source_video',contentType:'video/quicktime',bytes:before,open:async()=>createReadStream(source)},async ready=>{
    const file=(await ready.open() as ReturnType<typeof createReadStream>).path.toString();
    const result=JSON.parse(execFileSync(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-show_entries','stream=codec_name,width,height,avg_frame_rate:format=duration','-of','json',file],{encoding:'utf8'}));
    expect(result.streams[0].codec_name).toBe('h264');expect(result.streams[0].avg_frame_rate).toBe('24/1');
    expect(result.streams[0].width).toBeGreaterThanOrEqual(256);expect(result.streams[0].height).toBeGreaterThan(result.streams[0].width);
    expect(Number(result.format.duration)).toBeCloseTo(3,1);
   });
   expect((await stat(source)).size).toBe(before);
  }finally{await rm(dir,{recursive:true,force:true});}
 },30000);
 it('extends a short clip to two seconds without changing the original',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'h3-short-'));
  try{
   const source=path.join(dir,'short.mp4');
   execFileSync(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-f','lavfi','-i','color=blue:size=320x240:rate=24:duration=1','-c:v','libx264','-y',source]);
   const before=(await stat(source)).size;
   await withH3Video({role:'source_video',contentType:'video/mp4',bytes:before,open:async()=>createReadStream(source)},async ready=>{
    const stream=await ready.open();const file=(stream as ReturnType<typeof createReadStream>).path.toString();
    const info=JSON.parse(execFileSync(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-show_entries','format=duration','-of','json',file],{encoding:'utf8'}));
    expect(Number(info.format.duration)).toBeGreaterThanOrEqual(2);expect(Number(info.format.duration)).toBeLessThan(2.1);
   });
   expect((await stat(source)).size).toBe(before);
  }finally{await rm(dir,{recursive:true,force:true});}
 },30000);
 it('does not extend a clip already over two seconds',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'h3-normal-'));
  try{
   const source=path.join(dir,'normal.mp4');
   execFileSync(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-f','lavfi','-i','color=blue:size=320x240:rate=24:duration=3','-c:v','libx264','-y',source]);
   await withH3Video({role:'source_video',contentType:'video/mp4',bytes:(await stat(source)).size,open:async()=>createReadStream(source)},async ready=>{
    const stream=await ready.open();const file=(stream as ReturnType<typeof createReadStream>).path.toString();
    const info=JSON.parse(execFileSync(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-show_entries','format=duration','-of','json',file],{encoding:'utf8'}));
    expect(Number(info.format.duration)).toBeCloseTo(3,1);
   });
  }finally{await rm(dir,{recursive:true,force:true});}
 },30000);
 it('converts a long, small, low-frame-rate clip before uploading it',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'h3-test-'));
  try{
   const source=path.join(dir,'source.webm');
   execFileSync(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-f','lavfi','-i','color=red:size=120x80:rate=8:duration=16','-c:v','libvpx','-y',source]);
   const input={role:'source_video',contentType:'video/webm',bytes:(await stat(source)).size,open:async()=>createReadStream(source)};
   await withH3Video(input,async ready=>{
    expect(ready.contentType).toBe('video/mp4');expect(ready.bytes).toBeLessThan(100*1024*1024);
    const stream=await ready.open();const file=(stream as ReturnType<typeof createReadStream>).path.toString();
    const result=JSON.parse(execFileSync(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-show_entries','stream=width,height,avg_frame_rate:format=duration','-of','json',file],{encoding:'utf8'}));
    expect(Math.min(result.streams[0].width,result.streams[0].height)).toBeGreaterThanOrEqual(256);
    expect(result.streams[0].avg_frame_rate).toBe('24/1');expect(Number(result.format.duration)).toBeLessThanOrEqual(15);
   });
  }finally{await rm(dir,{recursive:true,force:true});}
 },30000);
});

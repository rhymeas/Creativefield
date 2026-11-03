import {execFileSync} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import sharp from 'sharp';
import {describe,it,expect,vi} from 'vitest';
import {routerAdapter,routerRegistrations} from '../server/providers/comfy-router';
import {ROUTER_MODELS} from '../src/capabilities/router-models';
import type {AdapterContext} from '../server/providers/types';

describe('H3 adapter media preparation',()=>{
 it('rejects unreadable uploaded video before contacting the provider',async()=>{
  const model=ROUTER_MODELS.find(m=>m.id==='router-h3-reference')!,upload=vi.fn(),api=vi.fn();
  const image=await sharp({create:{width:16,height:16,channels:3,background:'blue'}}).png().toBuffer();
  const context:AdapterContext={requestId:'invalid',binding:routerRegistrations.find(r=>r.binding.capabilityId===model.id)!.binding,transport:{upload,api,artifact:vi.fn()}};
  await expect(routerAdapter(model).prepareInputs([{role:'source_video',contentType:'video/mp4',bytes:3,open:async()=>Readable.from([Buffer.from('bad')])},{role:'reference_image',contentType:'image/png',bytes:image.length,open:async()=>Readable.from([image])}],context)).rejects.toThrow();
  expect(upload).not.toHaveBeenCalled();expect(api).not.toHaveBeenCalled();
 },30000);
 it('prepares a short clip and image through the adapter',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'h3-adapter-'));
  try{
   const source=path.join(dir,'short.webm');
   execFileSync(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-f','lavfi','-i','color=red:size=120x80:rate=8:duration=1','-c:v','libvpx','-y',source]);
   const image=await sharp({create:{width:80,height:120,channels:3,background:'blue'}}).png().toBuffer();
   const model=ROUTER_MODELS.find(m=>m.id==='router-h3-reference')!;
   const upload=vi.fn(async input=>{
    expect(input.contentType).toBe('video/mp4');
    const stream=await input.open();const file=(stream as ReturnType<typeof createReadStream>).path.toString();
    const info=JSON.parse(execFileSync(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-show_entries','stream=width,height,avg_frame_rate:format=duration','-of','json',file],{encoding:'utf8'}));
    expect(Number(info.format.duration)).toBeGreaterThanOrEqual(2);
    expect(info.streams[0].avg_frame_rate).toBe('24/1');expect(Math.min(info.streams[0].width,info.streams[0].height)).toBeGreaterThanOrEqual(256);
    stream.destroy();return 'https://storage.googleapis.com/fixture/short.mp4';
   });
   const context:AdapterContext={requestId:'test',binding:routerRegistrations.find(r=>r.binding.capabilityId===model.id)!.binding,transport:{upload,api:vi.fn(),artifact:vi.fn()}};
   const prepared=await routerAdapter(model).prepareInputs([{role:'source_video',contentType:'video/webm',bytes:(await stat(source)).size,open:async()=>createReadStream(source)},{role:'reference_image',contentType:'image/png',bytes:image.length,open:async()=>Readable.from([image])}],context);
   expect(upload).toHaveBeenCalledTimes(1);expect(prepared.source_video).toBe('https://storage.googleapis.com/fixture/short.mp4');expect(prepared.reference_image).toMatch(/^data:image\/png;base64,/);
  }finally{await rm(dir,{recursive:true,force:true});}
 },30000);
});

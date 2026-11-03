import {execFileSync} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import sharp from 'sharp';
import {describe,expect,it,vi} from 'vitest';
import {ROUTER_MODELS} from '../src/capabilities/router-models';
import {routerAdapter,routerRegistrations} from '../server/providers/comfy-router';
import type {AdapterContext,AdapterTransport,OwnedInput} from '../server/providers/types';

describe('H3 media preparation through the router adapter',()=>{
 it('uploads a converted video and submits a converted reference without changing the originals',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'h3-adapter-'));
  try{
   const source=path.join(dir,'source.webm');
   execFileSync(process.env.FFMPEG_PATH??'ffmpeg',['-v','error','-f','lavfi','-i','color=red:size=120x80:rate=8:duration=3','-c:v','libvpx','-y',source]);
   const image=await sharp({create:{width:100,height:80,channels:3,background:'blue'}}).webp().toBuffer();
   const videoSize=(await stat(source)).size,model=ROUTER_MODELS.find(item=>item.id==='router-h3-reference')!;
   const upload=vi.fn(async (video:OwnedInput)=>{
    expect(video.contentType).toBe('video/mp4');
    const stream=await video.open();
    const file=(stream as ReturnType<typeof createReadStream>).path.toString();
    const info=JSON.parse(execFileSync(process.env.FFPROBE_PATH??'ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,width,height,avg_frame_rate','-of','json',file],{encoding:'utf8'}));
    expect(info.streams[0]).toMatchObject({codec_name:'h264',avg_frame_rate:'24/1'});
    expect(Math.min(info.streams[0].width,info.streams[0].height)).toBeGreaterThanOrEqual(256);
    stream.destroy();
    return 'https://storage.googleapis.com/fixture/video.mp4';
   });
   const api=vi.fn<AdapterTransport['api']>(async()=>({request_id:'fixture-request'}));
   const context:AdapterContext={requestId:'fixture',binding:routerRegistrations.find(item=>item.binding.capabilityId===model.id)!.binding,transport:{api,upload,artifact:vi.fn()}};
   const adapter=routerAdapter(model);
   const prepared=await adapter.prepareInputs([{role:'source_video',contentType:'video/webm',bytes:videoSize,open:async()=>createReadStream(source)},{role:'reference_image',contentType:'image/webp',bytes:image.length,open:async()=>Readable.from([image])}],context);
   const reference=prepared.reference_image;
   if(typeof reference!=='string')throw new Error('Prepared reference is not a data URL');
   const converted=Buffer.from(reference.split(',')[1],'base64'),metadata=await sharp(converted).metadata();
   expect(reference).toMatch(/^data:image\/png;base64,/);
   expect(Math.min(metadata.width!,metadata.height!)).toBeGreaterThanOrEqual(256);
   const invocation={capabilityId:model.id,version:'1.0.0',routeId:'router',inputs:{source_video:'video',reference_image:'image'},controls:{prompt:'Keep the scene',duration:5,resolution:'768P',seed:1},audioPolicy:'replace' as const};
   expect(await adapter.submit(invocation,prepared,context)).toEqual({kind:'accepted',remoteId:'fixture-request'});
   const body=api.mock.calls[0][1]!.body as {content:Array<{video_url?:{url:string};image_url?:{url:string}}>};
   expect(body.content[1].video_url?.url).toBe('https://storage.googleapis.com/fixture/video.mp4');
   expect(body.content[2].image_url?.url).toBe(prepared.reference_image);
   expect((await stat(source)).size).toBe(videoSize);
  }finally{await rm(dir,{recursive:true,force:true});}
 },30000);
});

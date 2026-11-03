import {describe,it,expect,vi} from 'vitest';
import {Readable} from 'node:stream';
import {ROUTER_MODELS,routerManifest,routerModelsFor,routerInputProblem,cloudFeature,h3ReferenceDurationNote} from '../src/capabilities/router-models';
import {routerAdapter,routerRegistrations} from '../server/providers/comfy-router';
import type {AdapterContext,AdapterTransport} from '../server/providers/types';
import type {Invocation} from '../src/capabilities/types';
import schema from './fixtures/minimax-h3-router-openapi.json';
vi.mock('../server/providers/h3-video',()=>({withH3Video:async(input:unknown,upload:(value:unknown)=>Promise<unknown>)=>upload(input)}));
vi.mock('../server/providers/h3-image',()=>({prepareH3Images:async(inputs:{role:string}[])=>Object.fromEntries(inputs.map(input=>[input.role,'data:image/png;base64,cG5n']))}));

const model=ROUTER_MODELS.find(m=>m.id==='router-h3-reference')!;
const invocation=():Invocation=>({capabilityId:model.id,version:'1.0.0',routeId:'router',inputs:{source_video:'video-id',reference_image:'character-id'},controls:{prompt:'Keep the scene and performance.',duration:5,resolution:'768P',seed:42},audioPolicy:'replace'});
function setup(api=vi.fn<AdapterTransport['api']>(async()=>({request_id:'h3-request'}))){const adapter=routerAdapter(model),upload=vi.fn(async()=> 'https://storage.googleapis.com/fixture/source.mp4');const context:AdapterContext={requestId:'one-stable-intent',binding:routerRegistrations.find(r=>r.binding.capabilityId===model.id)!.binding,transport:{api,upload,artifact:vi.fn()}};return {adapter,api,context,upload};}
const image=(role:string)=>({role,contentType:'image/png',bytes:3,open:async()=>Readable.from([Buffer.from('png')])});
describe('OpenJutsu experimental managed H3 reference route (mocked; no model execution)',()=>{
 it('is its own feature and does not silently replace the existing video edit or motion models',()=>{expect(routerModelsFor('openjutsu').map(m=>m.id)).toEqual([model.id]);expect(cloudFeature('openjutsu','create','create')).toBe('openjutsu');expect(routerModelsFor('replace-character').map(m=>m.model)).toEqual(['kling/kling-v3-omni']);expect(routerManifest(model).audioPolicies).toEqual(['replace']);});
 it('requires both source and character and accepts only provider-generated replacement audio',()=>{const s=setup();expect(s.adapter.validate(invocation())).toEqual({valid:true});expect(s.adapter.validate({...invocation(),inputs:{reference_image:'i'}}).valid).toBe(false);expect(s.adapter.validate({...invocation(),inputs:{source_video:'v'}}).valid).toBe(false);expect(s.adapter.validate({...invocation(),audioPolicy:'mute'}).valid).toBe(false);expect(s.adapter.validate({...invocation(),audioPolicy:'preserve'}).valid).toBe(false);expect(s.adapter.validate({...invocation(),controls:{...invocation().controls,prompt:'x'.repeat(501)}}).valid).toBe(false);expect(s.api).not.toHaveBeenCalled();expect(s.upload).not.toHaveBeenCalled();});
 it('sends the reference instruction and media without extra prompt text',async()=>{
  const s=setup(),empty={...invocation(),controls:{...invocation().controls,prompt:''}};
  expect(s.adapter.validate(empty)).toEqual({valid:true});
  const prepared=await s.adapter.prepareInputs([{role:'source_video',contentType:'video/mp4',bytes:3,open:async()=>Readable.from([Buffer.from('mp4')])},image('reference_image')],s.context);
  await s.adapter.submit(empty,prepared,s.context);
  const body=s.api.mock.calls[0][1]!.body as any;
  expect(body.content[0].text).toContain('Use the character in Image 1');
  expect(body.content[1].role).toBe('reference_video');
  expect(body.content[2].role).toBe('reference_image');
 });
 it('passes clip and ordered character/scene data URIs through reference roles, never base_video or first_frame',async()=>{const s=setup(),prepared=await s.adapter.prepareInputs([{role:'source_video',contentType:'video/mp4',bytes:3,open:async()=>Readable.from([Buffer.from('mp4')])},image('reference_image'),image('reference_image_2')],s.context);await s.adapter.submit(invocation(),prepared,s.context);expect(s.upload).toHaveBeenCalledTimes(1);expect(s.api).toHaveBeenCalledTimes(1);expect(s.api.mock.calls[0][0]).toBe('/v2/models/minimax/minimax-h3/requests');
  const request=s.api.mock.calls[0][1]!,body=request.body as any,contract=schema.paths['/v2/models/minimax/minimax-h3'].post.requestBody.content['application/json'].schema;
  expect(request.idempotencyKey).toBe('one-stable-intent');for(const key of contract.required)expect(body).toHaveProperty(key);for(const key of Object.keys(body))expect(Object.keys(contract.properties)).toContain(key);
  expect(body.content[1]).toEqual({type:'video_url',video_url:{url:'https://storage.googleapis.com/fixture/source.mp4'},role:'reference_video'});expect(body.content.slice(2)).toEqual([1,2].map(()=>({type:'image_url',image_url:{url:'data:image/png;base64,cG5n'},role:'reference_image'})));expect(body.content[0].text).toContain('Image 2');expect(body.content[0].text).toContain('Video 1');expect(JSON.stringify(body)).not.toContain('base_video');expect(JSON.stringify(body)).not.toContain('first_frame');expect(body).not.toHaveProperty('generate_audio');expect(body).not.toHaveProperty('callback_url');expect(body.resolution).toBe('768P');
 });
 it('accepts convertible videos and images and validates the remaining constraints',()=>{const video={content_type:'video/mp4',bytes:2048,metadata:{width:1280,height:720,frameRate:'24/1',durationSeconds:5}},character={content_type:'image/png',bytes:1024,metadata:{width:800,height:800}};expect(routerInputProblem(model,{source_video:video,reference_image:character})).toBeUndefined();for(const metadata of [{...video.metadata,durationSeconds:16},{...video.metadata,frameRate:'12/1'},{...video.metadata,width:120}])expect(routerInputProblem(model,{source_video:{...video,metadata},reference_image:character})).toBeUndefined();expect(routerInputProblem(model,{source_video:{...video,metadata:{...video.metadata,durationSeconds:1}}})).toBeUndefined();expect(routerInputProblem(model,{source_video:{...video,metadata:{...video.metadata,durationSeconds:0}}})).toContain('readable video');expect(routerInputProblem(model,{reference_image:{...character,content_type:'image/webp',metadata:{width:100,height:100}}})).toBeUndefined();expect(routerInputProblem(model,{reference_image:{...character,metadata:{width:2000,height:256}}})).toBeUndefined();});
 it('explains automatic duration changes for the selected source',()=>{
  expect(h3ReferenceDurationNote(1)).toContain('held');
  expect(h3ReferenceDurationNote(16)).toContain('first 15 seconds');
  expect(h3ReferenceDurationNote(2)).toBeUndefined();expect(h3ReferenceDurationNote(15)).toBeUndefined();expect(h3ReferenceDurationNote(undefined)).toContain('first 15 seconds');
 });
 it('accepts ordinary uploaded H3 inputs without optional probe metadata',()=>{
  expect(routerInputProblem(model,{source_video:{content_type:'video/mp4',bytes:1024,metadata:{}},reference_image:{content_type:'image/png',bytes:1024,metadata:{imageValidation:{width:16,height:16}}}})).toBeUndefined();
  expect(routerInputProblem(model,{source_video:{content_type:'video/mp4',bytes:1024,metadata:{durationSeconds:0}}})).toContain('readable video');
 });
 it('uses the MiniMax task/content/url envelope and refuses failed tasks or a different model’s result shape',async()=>{const api=vi.fn<AdapterTransport['api']>().mockResolvedValueOnce({task:{status:'succeeded',content:{url:'https://storage.googleapis.com/output.mp4'}}}).mockResolvedValueOnce({task:{status:'failed',content:{url:'https://storage.googleapis.com/untrusted.mp4'}}}).mockResolvedValueOnce({video:{url:'https://storage.googleapis.com/fal-output.mp4'}});const s=setup(api);expect(await s.adapter.outputs('h3-id',s.context)).toEqual([{url:'https://storage.googleapis.com/output.mp4',mediaType:'video',contentType:'video/mp4'}]);await expect(s.adapter.outputs('h3-id',s.context)).rejects.toThrow();await expect(s.adapter.outputs('h3-id',s.context)).rejects.toThrow();});
 it('never resubmits an ambiguous request or generates an anchor as a hidden step',async()=>{const s=setup(vi.fn().mockRejectedValue(new Error('unknown acknowledgement')));expect(await s.adapter.submit(invocation(),{},s.context)).toEqual({kind:'unknown'});expect(s.api).toHaveBeenCalledTimes(1);expect(await s.adapter.recover(s.context)).toEqual({kind:'unsupported'});expect(s.upload).not.toHaveBeenCalled();});
});

import {describe,expect,it} from 'vitest';
import {buildCatalogue} from '../src/capabilities/catalogue';
import {providers} from '../src/pipelines/registry';
import {keyframeShotTiming} from '../server/keyframe-storyboard';
import {assemblySchema} from '../server/assembly';

describe('keyframe storyboard admission',()=>{
 const model=buildCatalogue(providers).find(b=>b.manifest.id==='wan22-flf2v-14b')!.manifest;
 it('uses the first segment in full and drops one shared frame in later segments',()=>{
  const first=keyframeShotTiming(model,2,16,0,{start_image:'a',end_image:'b'},'turn');
  const next=keyframeShotTiming(model,3,16,1,{start_image:'b',end_image:'c'},'rise','b');
  expect(first).toMatchObject({controlSeconds:2,generationFrames:33,frames:33,assemblyStartFrame:0});
  expect(next).toMatchObject({controlSeconds:3,generationFrames:49,frames:48,assemblyStartFrame:1});
  expect(assemblySchema.parse({width:832,height:480,fps:16,audioPolicy:'mute',keyframeBoundaries:true}).keyframeBoundaries).toBe(true);
 });
 it('rejects disconnected images, fractional frames and model-incompatible timing',()=>{
  expect(()=>keyframeShotTiming(model,2,16,1,{start_image:'x',end_image:'c'},'turn','b')).toThrow('share');
  expect(()=>keyframeShotTiming(model,2.01,16,0,{start_image:'a',end_image:'b'},'turn')).toThrow('whole output frames');
  expect(()=>keyframeShotTiming(model,2,24,0,{start_image:'a',end_image:'b'},'turn')).toThrow('model frame rate');
 });
});

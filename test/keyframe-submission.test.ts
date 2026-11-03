import {describe,expect,it} from 'vitest';
import {buildCatalogue} from '../src/capabilities/catalogue';
import {providers} from '../src/pipelines/registry';
import {compileLocal} from '../src/capabilities/compile';
import {buildKeyframeShots,definitiveKeyframeRejection,uncertainKeyframeCreation} from '../src/team/keyframe-submission';
import {keyframeSpans} from '../src/team/keyframe-plan';
import h3 from '../native-workflows/h3-flf2v/manifest.json';
import type {CapabilityManifestV2} from '../src/capabilities/types';

describe('keyframe storyboard inputs',()=>{
 it('keeps the idempotency key after uncertain render responses',()=>{
  for(const status of [401,408,409,429,500,503])expect(definitiveKeyframeRejection(status)).toBe(false);
  for(const status of [400,403,404,422])expect(definitiveKeyframeRejection(status)).toBe(true);
 });
 it('permits board creation retry only after a definite rejection',()=>{
  for(const status of [undefined,408,409,429,500,503])expect(uncertainKeyframeCreation(status)).toBe(true);
  for(const status of [400,401,403,404,422])expect(uncertainKeyframeCreation(status)).toBe(false);
 });
 it('passes portrait and supported speed choices into segment generation and assembly',()=>{
  const wan=buildCatalogue(providers).find(b=>b.manifest.id==='wan22-flf2v-14b')!.manifest;
  const frames=[{assetId:'a',frame:0},{assetId:'b',frame:32}];
  const portrait=buildKeyframeShots(wan,frames,[''],16,{orientation:'portrait',turbo:true});
  expect([portrait.width,portrait.height]).toEqual([480,832]);
  expect(portrait.shots[0].settings.generation.controls).toMatchObject({width:480,height:832});
  const model=h3 as unknown as CapabilityManifestV2,span=keyframeSpans(model)[0];
  const h3plan=buildKeyframeShots(model,[{assetId:'a',frame:0},{assetId:'b',frame:span}],[''],24,{orientation:'portrait',turbo:false});
  expect([h3plan.width,h3plan.height]).toEqual([736,1280]);
  const landscape=buildKeyframeShots(model,[{assetId:'a',frame:0},{assetId:'b',frame:span}],[''],24,{orientation:'landscape',turbo:true});
  expect([landscape.width,landscape.height]).toEqual([1280,736]);
  expect(landscape.shots[0].settings.generation.controls).toMatchObject({aspect_ratio:'16:9 (Widescreen)',megapixels:0.9});
  expect(h3plan.shots[0].settings.generation.controls).toMatchObject({aspect_ratio:'9:16 (Portrait Widescreen)',turbo:false});
 });
 it('sends the correct images, prompts and model settings for each segment',()=>{
  const bundle=buildCatalogue(providers).find(b=>b.manifest.id==='wan22-flf2v-14b')!;
  const plan=buildKeyframeShots(bundle.manifest,[{assetId:'a',frame:0},{assetId:'b',frame:32},{assetId:'c',frame:80}],['move','turn'],16);
  expect(plan.shots.map(s=>s.prompt)).toEqual(['move','turn']);
  expect(plan.shots.map(s=>s.assets.map(a=>a.assetId))).toEqual([['a','b'],['b','c']]);
  expect(plan.shots.map(s=>s.durationSeconds)).toEqual([2,3]);
  for(const shot of plan.shots){
   expect(shot.settings.generation.controls).not.toHaveProperty('prompt');
   expect(shot.settings.generation.controls).not.toHaveProperty('length');
   const graph=compileLocal(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:'local',inputs:{start_image:'comfyfield-a.png',end_image:'comfyfield-b.png'},controls:{...shot.settings.generation.controls,prompt:shot.prompt,length:shot.durationSeconds},audioPolicy:'mute'});
   expect(graph[bundle.manifest.controls.find(c=>c.id==='length')!.binding!.node].inputs.length).toBe(shot.durationSeconds*16+1);
  }
 });
});

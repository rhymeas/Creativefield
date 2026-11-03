import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {buildCatalogue} from '../src/capabilities/catalogue';
import {providers} from '../src/pipelines/registry';
import {KeyframeStudio,draftFrameRate,keyframeModels} from '../src/team/KeyframeStudio';
import {videoModeFromHash} from '../src/team/video-edit/state';
import {routeState} from '../src/team/route-state';
import h3 from '../native-workflows/h3-flf2v/manifest.json';
import type {CapabilityManifestV2} from '../src/capabilities/types';

describe('keyframe workspace',()=>{
 it('restores the original frame rate even when the old model is no longer selectable',()=>{
  const old={id:'old',timing:{fps:16}} as CapabilityManifestV2;
  expect(draftFrameRate({modelId:'old'},[old],24)).toBe(16);
  expect(draftFrameRate({modelId:'old',fps:25},[old],24)).toBe(25);
 });
 it('opens from its video route and renders frame inputs and a transition prompt',()=>{
  expect(videoModeFromHash('#video/keyframes')).toBe('keyframes');
  expect(routeState({section:'video',hash:'#video/keyframes',mode:'keyframes',canCreate:true,catalogueKnown:true,video:true,motion:true,image:true,audioKnown:true,audio:true,trimKnown:true,trim:true}).kind).toBe('screen');
  const html=renderToStaticMarkup(<KeyframeStudio workspace={{id:'workspace',name:'Studio',role:'creator'}} project={{id:'project',name:'Film'}} user={{id:'user'} as never} catalogue={[...buildCatalogue(providers).map(b=>b.manifest),h3 as unknown as CapabilityManifestV2]} workers={[]} call={async()=>({items:[]}) as never} authorized canEdit localEnabled onChanged={()=>{}}/>);
  expect(html).toContain('Frame 1');expect(html).toContain('Frame 2');expect(html).toContain('Segment 1');expect(html).toContain('Animate');
  expect(keyframeModels([...buildCatalogue(providers).map(b=>b.manifest),h3 as unknown as CapabilityManifestV2]).map(m=>m.id)).toEqual(['h3-flf2v']);
 });
});

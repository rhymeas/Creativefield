import {describe,expect,it} from 'vitest';
import {foleySegmentGraph,foleySingleVideoGraph} from '../server/foley-graph';

describe('Foley segment graph',()=>{
 it('uses the same single selected excerpt for sound generation and video output',()=>{
  const graph=foleySingleVideoGraph('comfyfield-abc.mp4','Rain',42,12,30) as any;
  expect(graph['7']).toEqual({class_type:'Video Slice',inputs:{video:['1',0],start_time:12,duration:30,strict_duration:false}});
  expect(graph['3'].inputs.video_input).toEqual(['8',0]);
  expect(graph['3'].inputs.duration).toBe(30);
  expect(graph['4'].inputs.video).toEqual(['7',0]);
  expect(graph['8']).toEqual({class_type:'CreateVideo',inputs:{images:['4',0],fps:['4',2]}});
  expect(graph['5'].inputs).toMatchObject({images:['4',0],audio:['3',0],fps:['4',2]});
  expect((foleySingleVideoGraph('comfyfield-a.mp4','rain',1,0,4.5) as any)['3'].inputs.duration).toBe(4.5);
  for(const seconds of [0,0.69,30.1,NaN,Infinity])expect(()=>foleySingleVideoGraph('comfyfield-a.mp4','rain',1,0,seconds)).toThrow();
  expect(()=>foleySingleVideoGraph('comfyfield-a.mp4','rain',1,-1,3)).toThrow();
 });
 it('binds the clip and prompt to the pinned nodes and saves generated audio',()=>{
  const graph=foleySegmentGraph('comfyfield-abc-1.mp4','Rain on a roof',42) as any;
  expect(graph['1'].inputs.file).toBe('comfyfield-abc-1.mp4');
  expect(graph['2'].inputs.auto_fetch_source).toBe(false);
  expect(graph['3'].inputs).toMatchObject({video_input:['1',0],controlfoley_model:['2',0],prompt:'Rain on a roof',seed:42});
  expect(graph['6']).toEqual({class_type:'SaveAudio',inputs:{audio:['3',0],filename_prefix:'ComfyField/foley-segment'}});
 });
 it('refuses unsafe names and invalid inputs',()=>{
  expect(()=>foleySegmentGraph('../clip.mp4','rain',1)).toThrow();
  expect(()=>foleySegmentGraph('comfyfield-a.mp4',' ',1)).toThrow();
  expect(()=>foleySegmentGraph('comfyfield-a.mp4','rain',-1)).toThrow();
 });
});

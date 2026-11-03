import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

describe('video sound workflow candidate',()=>{
 it('sends the source video and prompt to generation and combines the original frames with generated audio',()=>{
  const graph=JSON.parse(readFileSync('workflow-candidates/controlfoley-video-sound.api.json','utf8'));
  expect(graph['1'].class_type).toBe('LoadVideo');
  expect(graph['2'].inputs.auto_fetch_source).toBe(false);
  expect(graph['3'].inputs).toMatchObject({video_input:['1',0],controlfoley_model:['2',0],prompt:''});
  expect(graph['4'].inputs.video).toEqual(['1',0]);
  expect(graph['5'].inputs).toEqual({images:['4',0],fps:['4',2],audio:['3',0]});
  expect(graph['6'].inputs).toMatchObject({video:['5',0],format:'mp4','format.codec':'h264'});
  expect(graph['6'].inputs).not.toHaveProperty('codec');
 });
});

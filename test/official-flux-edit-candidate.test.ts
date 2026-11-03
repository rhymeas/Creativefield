import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

describe('official FLUX edit candidate',()=>{
 it('starts with neutral inputs and preserves the proposed prompt switch',()=>{
  const graph=JSON.parse(readFileSync('workflow-candidates/flux3-official-edit.api.json','utf8'));
  expect(graph['11'].inputs.image).toBe('source.png');
  expect(graph['49'].inputs.prompt).toBe('');
  expect(graph['33'].inputs.editor_state).toEqual({__value__:[]});
  expect(graph['51'].inputs).toMatchObject({switch:true,on_false:['34',0],on_true:['47',0]});
  expect(graph['7'].inputs).toHaveProperty('seed');
  expect(graph['47'].inputs).toHaveProperty('sampling_mode.seed');
  expect(graph['9'].class_type).toBe('SaveImage');
 });
});

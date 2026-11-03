import {describe,expect,it} from 'vitest';
import {insertReferenceMention,modelPromptReferences} from '../src/team/prompt-reference';

describe('reference prompt binding',()=>{
 it('inserts a reference at the caret and preserves surrounding text',()=>{
  expect(insertReferenceMention('Replace person now',8,14,'@Image 2')).toEqual({value:'Replace @Image 2 now',caret:16});
 });
 it('translates only bound picture slots, including gaps',()=>{
  const prompt='Use @Image 1 and @Image 2; ignore @Image 10.';
  expect(modelPromptReferences(prompt,'h3',[2])).toBe('Use @Image 1 and <Picture 2>; ignore @Image 10.');
  expect(modelPromptReferences(prompt,'plain',[1])).toBe('Use image 1 and @Image 2; ignore @Image 10.');
 });
});

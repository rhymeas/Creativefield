import { describe, expect, it } from 'vitest';
import { explainError, explainNode } from '../server/comfy-node-help.mjs';
describe('local node explanations', () => {
  it('explains KSampler in everyday language and its encoded output', () => {
    const guide = explainNode('KSampler', { description: 'Technical upstream description' });
    expect(guide.source).toBe('ComfyField guide');
    expect(guide.text).toContain('turning random noise');
    expect(guide.text).toContain('VAE Decode');
  });
  it('uses the extension author description for unknown nodes', () => {
    expect(explainNode('MyExtension', { description: '  Combines two pictures.  ' })).toEqual({ text: 'Combines two pictures.', source: 'Node author’s description' });
  });
  it('does not invent behavior when the author supplied no explanation', () => {
    const info = explainNode('MysteryNode', { input: { required: { image: {}, strength: {} } }, output_name: ['IMAGE'] });
    expect(info.text).toContain('no explanation from its author');
    expect(info.text).toContain('Required inputs: image, strength');
    expect(info.text).toContain('Outputs: IMAGE');
  });
});
describe('compact workflow error guidance', () => {
  it('turns the screenshot model-matrix error into one actionable hint', () => {
    expect(explainError('RuntimeError: mat1 and mat2 shapes cannot be multiplied (86x2560 and 4096x5120)')).toEqual({
      title: 'Model and text encoder do not match',
      hint: 'Choose a workflow made for this model family. Its model and prompt encoder must be compatible.',
    });
  });
  it('keeps unknown failures short and points back to the failed node', () => {
    expect(explainError('Unexpected upstream failure').hint).toBe('Check the highlighted node and its connected inputs, then try again.');
  });
});

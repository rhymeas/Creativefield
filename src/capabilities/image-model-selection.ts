/** Workflows exposed as image models under the current product model selection.
 * IDs retain their existing names even when a workflow uses FLUX 3 weights. */
const IMAGE_MODEL_WORKFLOWS=new Set([
  'flux2-klein-t2i','flux2-klein-edit','flux2-klein-angles','flux2-klein-relight',
  'qwen-image-21-t2i','qwen-image-21-edit','qwen-image-21-angles','fibo2-edit',
]);

export function isSelectedImageModel(id:string):boolean { return IMAGE_MODEL_WORKFLOWS.has(id); }

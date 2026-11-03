import {describe,expect,it} from 'vitest';
import {isSelectedImageModel} from '../src/capabilities/image-model-selection';

describe('image model selection',()=>{
 it('exposes only the selected image model workflows',()=>{
  for(const id of ['flux2-klein-t2i','flux2-klein-edit','flux2-klein-angles','flux2-klein-relight','qwen-image-21-t2i','qwen-image-21-edit','qwen-image-21-angles','fibo2-edit'])expect(isSelectedImageModel(id),id).toBe(true);
  for(const id of ['z-image-turbo-t2i','moss-image-t2i','bg-remove-birefnet','unknown'])expect(isSelectedImageModel(id),id).toBe(false);
 });
});

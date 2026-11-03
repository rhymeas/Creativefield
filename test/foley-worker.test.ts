import {describe,expect,it,vi} from 'vitest';
import {foleyWorkerGenerator} from '../server/foley-worker';

describe('Foley segment worker adapter',()=>{
 it('rejects invalid descriptions and seeds before uploading anything',()=>{
  const worker={upload:vi.fn(),run:vi.fn()};
  expect(()=>foleyWorkerGenerator(worker,'job',' ',42)).toThrow('sound description');
  expect(()=>foleyWorkerGenerator(worker,'job','rain',-1)).toThrow('seed');
  expect(worker.upload).not.toHaveBeenCalled();
  expect(worker.run).not.toHaveBeenCalled();
 });
 it('uploads the source segment and dispatches its graph with a stable segment key',async()=>{
  const worker={upload:vi.fn().mockResolvedValue('comfyfield-job-1.mp4'),run:vi.fn().mockResolvedValue(undefined)};
  await foleyWorkerGenerator(worker,'job-1','Rain',42)('clip.mp4','result.wav',1);
  expect(worker.upload).toHaveBeenCalledWith('clip.mp4',undefined);
  expect(worker.run).toHaveBeenCalledWith(expect.objectContaining({'1':expect.objectContaining({inputs:{file:'comfyfield-job-1.mp4'}})}),'foley:job-1:1','result.wav',undefined);
 });
 it('does not dispatch after cancellation or an invalid upload name',async()=>{
  const worker={upload:vi.fn().mockResolvedValue('../wrong.mp4'),run:vi.fn()};
  await expect(foleyWorkerGenerator(worker,'job','Rain',42)('clip','out',0)).rejects.toThrow();
  expect(worker.run).not.toHaveBeenCalled();
  const controller=new AbortController();controller.abort();
  await expect(foleyWorkerGenerator(worker,'job','Rain',42)('clip','out',0,controller.signal)).rejects.toThrow();
  expect(worker.upload).toHaveBeenCalledTimes(1);
 });
});

import {afterEach,describe,expect,it,vi} from 'vitest';
import {trimToFirst} from '../src/team/TrimToFit';
import type {Call} from '../src/team/api';

afterEach(()=>vi.useRealTimers());
function fixture(previous:unknown[]=[]){
 const calls:Array<{path:string;method?:string;body?:any}>=[];
 const call=vi.fn(async(path:string,method?:string,body?:unknown)=>{
  calls.push({path,method,body});
  if(path.endsWith('video-sources/prepare'))return {id:'ready'};
  if(path.endsWith('video-extension-plans'))return {source:{frameCount:120,frameRate:{numerator:30,denominator:1},hasAudio:true}};
  if(path.includes('video-extensions?'))return previous;
  if(path.endsWith('/video-extensions'))return {id:'new',state:'succeeded',output_asset_id:'result'};
  if(path.endsWith('/video-extensions/old'))return {id:'old',state:'succeeded',output_asset_id:'old-result'};
  throw new Error(`Unexpected request ${path}`);
 });
 return {call:call as unknown as Call,calls};
}
describe('automatic first-part trim',()=>{
 it('preserves source rate in new cuts and reports the selected duration',async()=>{
  const f=fixture();expect(await trimToFirst(f.call,'workspace','project','source',81)).toEqual({id:'result',seconds:2.7});
  expect(f.calls.find(c=>c.path.endsWith('/video-extensions'))?.body).toMatchObject({endFrameExclusive:81,preserveFrameRate:true,idempotencyKey:'first-fps-ready-81',audioPolicy:'preserve'});
 });
 it('waits for an in-flight legacy cut instead of starting a duplicate',async()=>{
  vi.useFakeTimers();const f=fixture([{id:'old',state:'pending'}]);const result=trimToFirst(f.call,'workspace','project','source',81);
  await vi.advanceTimersByTimeAsync(1000);expect(await result).toEqual({id:'old-result',seconds:2.7});
  expect(f.calls.some(c=>c.method==='POST'&&c.path.endsWith('/video-extensions'))).toBe(false);
 });
});

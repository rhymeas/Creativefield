import {describe,expect,it} from 'vitest';
import {planFoleyWindows} from '../server/foley-timeline';

describe('ControlFoley timeline windows',()=>{
 it.each([0.7,8,30,30.1,60.001,120.5])('covers %s seconds without gaps or short tails',duration=>{
  const windows=planFoleyWindows(duration);
  expect(windows[0].startMs).toBe(0);
  expect(windows.at(-1)?.endMs).toBe(Math.round(duration*1000));
  for(const [index,window] of windows.entries()){
   expect(window.endMs-window.startMs).toBeGreaterThanOrEqual(700);
   expect(window.endMs-window.startMs).toBeLessThanOrEqual(30000);
   if(index)expect(window.startMs).toBe(windows[index-1].endMs);
  }
 });
 it.each([0,0.699,NaN,Infinity])('rejects unsupported duration %s',duration=>expect(()=>planFoleyWindows(duration)).toThrow());
});

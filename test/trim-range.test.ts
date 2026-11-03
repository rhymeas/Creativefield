import {describe,expect,it} from 'vitest';
import {constrainTrimRange} from '../src/team/trim-range';

describe('quick trim duration limits',()=>{
 it('moves the opposite edge when either handle exceeds the maximum',()=>{
  expect(constrainTrimRange(10,400,100,500,48,360)).toEqual([10,370]);
  expect(constrainTrimRange(100,490,100,500,48,360)).toEqual([130,490]);
 });
 it('keeps at least the required duration when either handle moves inward',()=>{
  expect(constrainTrimRange(370,400,100,500,48,360)).toEqual([352,400]);
  expect(constrainTrimRange(100,120,100,500,48,360)).toEqual([100,148]);
 });
});

import {describe,expect,it,vi} from 'vitest';
import {composerResultAssets,type Asset,type Call} from '../src/team/api';

describe('image result asset lookup',()=>{
 it('deduplicates outputs and uses bounded batches',async()=>{
  const ids=Array.from({length:201},(_,i)=>`asset-${i}`);
  const call=vi.fn(async(_path:string,_method?:string,body?:unknown)=>({items:(body as {ids:string[]}).ids.map(id=>({id})) as Asset[]}));
  const result=await composerResultAssets(call as Call,'workspace','project',[...ids,ids[0]]);
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls.map(([,method,body])=>[method,(body as {ids:string[]}).ids.length])).toEqual([['POST',200],['POST',1]]);
  expect(result.map(asset=>asset.id)).toEqual(ids);
 });
 it('does not issue a lookup for an empty result list',async()=>{
  const call=vi.fn();expect(await composerResultAssets(call as Call,'workspace','project',[])).toEqual([]);expect(call).not.toHaveBeenCalled();
 });
});

import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {TrimToFit} from '../../src/team/TrimToFit';
import type {Call} from '../../src/team/api';

let complete:(value:unknown)=>void=()=>{};
let fail:()=>void=()=>{},record:(key:string,preserve:boolean)=>void=()=>{};
const call:Call=async <T,>(path:string,method?:string,body?:unknown)=>{
  if(path.includes('video-sources/prepare'))return {id:'fixture-source'} as T;
  if(path.includes('video-extension-plans'))return {source:{frameCount:new URLSearchParams(location.search).has('short')?24:48,frameRate:{numerator:24,denominator:1},hasAudio:false}} as T;
  if(path.endsWith('/video-extensions')&&method==='POST'){
    record((body as {idempotencyKey:string}).idempotencyKey,(body as {preserveFrameRate?:boolean}).preserveFrameRate===true);
    return await new Promise<T>((resolve,reject)=>{complete=value=>resolve(value as T);fail=()=>reject(new Error('Simulated lost response'));});
  }
  throw new Error('Unexpected fixture request');
};
function Fixture(){
  const [open,setOpen]=useState(true),[result,setResult]=useState('none'),[keys,setKeys]=useState<string[]>([]),[mode,setMode]=useState('waiting');
  record=(key,preserve)=>{setKeys(old=>[...old,key]);setMode(preserve?'preserve':'legacy');};
  return <><button onClick={()=>setOpen(true)}>Open trim</button><button onClick={()=>complete({id:'fixture-job',state:'succeeded',output_asset_id:'fixture-output'})}>Complete pending cut</button><button onClick={()=>complete({id:'fixture-job',state:'failed',output_asset_id:null,error:'Simulated failure'})}>Fail cut</button><button onClick={()=>fail()}>Lose response</button><output aria-label="Trim result">{result}</output><output aria-label="Retry keys">{keys.length>1?(keys.at(-1)===keys.at(-2)?'same key':'different key'):'waiting'}</output><output aria-label="Frame rate mode">{mode}</output>{open&&<TrimToFit workspace={{id:'fixture',name:'Fixture',role:'creator'}} project={{id:'fixture',name:'Fixture'}} call={call} assetId="fixture-source" open={open} onClose={()=>setOpen(false)} onTrimmed={setResult}/>}</>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);

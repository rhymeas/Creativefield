/* Dreamina (CapCut) image generation through the official Dreamina Canvas CLI (PLAN: Dreamina image route).
   The CLI owns sign-in and tokens (OS keyring); ComfyField only names a per-user profile and never reads credentials.
   Credits are spent only inside a run whose credit ceiling the person approved; the CLI refuses above it. */
import {execFile} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Image models this route offers, with their reference and prompt limits (CLI model list, 2026-11-24). */
export const DREAMINA_IMAGE_MODELS={
 'seedream_5.0_pro':{title:'Seedream 5.0 Pro',maxRefs:6,maxPrompt:5000},
 'seedream_5.5':{title:'Seedream 5.5',maxRefs:6,maxPrompt:5000},
 'seedream_5.0_lite':{title:'Seedream 5.0 Lite',maxRefs:6,maxPrompt:4000},
 gpt_image_2:{title:'GPT Image 2',maxRefs:6,maxPrompt:7000},
 gemini_3_image_pro:{title:'Nano Banana Pro',maxRefs:6,maxPrompt:5000},
} as const;
export type DreaminaImageModel=keyof typeof DREAMINA_IMAGE_MODELS;
export const DREAMINA_RATIOS=['16:9','9:16','1:1','4:3','3:4','3:2','2:3','21:9'] as const;
export const DREAMINA_RESOLUTIONS=['1K','1.5K','2K','3K','4K'] as const;
/** Largest ceiling one run may approve. Quotes 2026-11-24: Seedream 5.5 1.5K 8, Seedream 5.0 Pro 1.5K 11, 2K 15 credits. The CLI has no Unlimited mode; that exists only in the web app. */
export const DREAMINA_MAX_CEILING=100;

export type DreaminaAccount={connected:boolean;name?:string;credits?:number};
export type DreaminaLogin={verificationUrl:string;userCode:string;expiresAt:string;done:Promise<boolean>;close:()=>void};
export type DreaminaRequest={model:DreaminaImageModel;ratio:string;resolution:string;prompt:string;references:string[];creditCeiling:number;title:string};
export type DreaminaImage={bytes:Buffer;model:string;credits?:number;submitId?:string};
export interface DreaminaNative {
 status(profile:string):Promise<DreaminaAccount>;
 login(profile:string):Promise<DreaminaLogin>;
 logout(profile:string):Promise<void>;
 generate(profile:string,workDir:string,request:DreaminaRequest,signal:AbortSignal):Promise<DreaminaImage>;
}
/** Profile names are derived from the ComfyField user id only. */
export const dreaminaProfile=(userId:string)=>{if(!/^[0-9a-f-]{36}$/.test(userId))throw new Error('Invalid user');return `cf-${userId}`;};
/** Only operating-system necessities reach the CLI: no ComfyField secrets or provider keys. */
export function dreaminaEnv(env:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
 const allowed=['PATH','Path','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','USERPROFILE','HOME','LOCALAPPDATA','APPDATA','HOMEDRIVE','HOMEPATH','XDG_CONFIG_HOME','XDG_DATA_HOME'];
 return Object.fromEntries(allowed.filter(k=>env[k]!==undefined).map(k=>[k,env[k]]));
}
type Json={ok?:boolean;data?:any;error?:{code?:number;message?:string;diagnostics?:{detail?:string}[]}};
/** One plain sentence from a CLI failure, without request ids or paths. */
export function dreaminaReason(result:Json|undefined,fallback:string):string{
 const resource=result?.data?.submission?.resources?.find?.((r:any)=>r?.state==='failed');
 const text=String(resource?.message??result?.error?.diagnostics?.[0]?.detail??result?.error?.message??'').replace(/[A-Z]:[\\/][^\s"]*/g,'').trim();
 if(/copyright/i.test(text))return 'Dreamina rejected the result in its copyright check. Change the prompt and try again.';
 if(/ceiling|credit/i.test(text))return 'The approved credit ceiling is below Dreamina’s price for this image. Approve a higher ceiling.';
 if(/sign|auth|login|token/i.test(text))return 'Sign in to Dreamina again.';
 return text&&text.length<=200?text:fallback;
}

export function createDreaminaNative(cli=process.env.DREAMINA_CLI??'dreamina-canvas'):DreaminaNative{
 const run=(profile:string,args:string[],timeoutMs:number,signal?:AbortSignal)=>new Promise<Json>((resolve,reject)=>{
  const child=execFile(cli,['--format','json','--non-interactive','--profile',profile,...args],{env:dreaminaEnv(),windowsHide:true,maxBuffer:32*1024*1024,timeout:timeoutMs,signal},(error,stdout,stderr)=>{
   const text=String(stdout||stderr||'').trim();let parsed:Json|undefined;try{parsed=JSON.parse(text);}catch{/* not JSON */}
   if(parsed)return resolve(parsed);
   reject(new Error(error&&(error as any).code==='ENOENT'?'The Dreamina CLI is not installed on this machine.':signal?.aborted?'Image generation canceled.':'The Dreamina CLI did not answer.'));
  });
  child.stdin?.end();
 });
 const canvases=new Map<string,string>();
 async function canvas(profile:string){
  const known=canvases.get(profile);if(known)return known;
  const current=await run(profile,['canvas','current'],30000);
  const pick=(d:any)=>String(d?.currentCanvas?.canvas?.projectId??d?.canvas?.projectId??d?.projectId??d?.project?.projectId??'');
  let id=current.ok?pick(current.data):'';
  if(!/^[0-9a-f-]{36}$/.test(id)){const made=await run(profile,['canvas','create','CreativeField','--use'],30000);id=pick(made.data);}
  if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('Dreamina has no canvas for this account.');
  canvases.set(profile,id);return id;
 }
 return {
  async status(profile){
   const s=await run(profile,['auth','status'],20000);if(!s.ok||s.data?.loggedIn!==true)return {connected:false};
   const a=await run(profile,['auth','account'],20000),credits=Number(a.data?.availableCredits);
   return {connected:true,name:typeof a.data?.displayName==='string'?a.data.displayName:undefined,credits:Number.isFinite(credits)?credits:undefined};
  },
  async login(profile){
   const r=await run(profile,['auth','login','--no-browser'],30000),c=r.data?.challenge;
   if(!r.ok||!c)throw new Error(dreaminaReason(r,'Dreamina sign-in could not start.'));
   const url=new URL(String(c.verificationUriComplete??c.verificationUri));
   if(url.protocol!=='https:'||!/(^|\.)capcut\.com$|(^|\.)dreamina\./.test(url.hostname)||typeof c.userCode!=='string'||c.userCode.length>40||typeof c.deviceCode!=='string')throw new Error('Invalid Dreamina sign-in response.');
   const abort=new AbortController();
   const done=run(profile,['auth','wait','--device-code',c.deviceCode,'--timeout','10m'],11*60000,abort.signal).then(w=>w.ok===true).catch(()=>false);
   return {verificationUrl:url.href,userCode:c.userCode,expiresAt:String(c.expiresAt??''),done,close:()=>abort.abort()};
  },
  async logout(profile){canvases.delete(profile);await run(profile,['auth','logout'],20000);},
  async generate(profile,workDir,request,signal){
   const project=await canvas(profile),refs:string[]=[];
   for(const file of request.references){
    const up=await run(profile,['resource','upload','--file',file,'--project-id',project],120000,signal);
    if(!up.ok||!up.data?.resourceId)throw new Error(dreaminaReason(up,'A reference image could not be uploaded to Dreamina.'));refs.push(String(up.data.resourceId));
   }
   const r=await run(profile,['node','create','image','--project-id',project,'--model',request.model,'--mode',refs.length?'i2i':'t2i','--ratio',request.ratio,'--resolution',request.resolution,
    '--prompt',request.prompt,...refs.flatMap(id=>['--ref',`res:${id}`]),'--title',request.title.slice(0,120),'--run','--wait','--credit-ceiling',String(request.creditCeiling),'--timeout','10m'],11*60000,signal);
   const sub=r.data?.submission,res=sub?.resources?.find?.((x:any)=>x?.state==='succeeded')?.resourceId;
   if(!r.ok||sub?.state!=='succeeded'||!res)throw new Error(dreaminaReason(r,'Dreamina could not make this image.'));
   await mkdir(workDir,{recursive:true});const file=join(workDir,'result.img');
   // The image is already paid for: a broken download stream is retried instead of failing the run (seen 2026-11-24).
   let d:Json|undefined;
   for(let attempt=0;attempt<4&&!signal.aborted;attempt++){
    d=await run(profile,['resource','download',String(res),'-o',file,'--project-id',project],180000,signal).catch(e=>({ok:false,error:{message:(e as Error).message}}));
    if(d.ok)break;
    await new Promise(resolve=>setTimeout(resolve,2000*(attempt+1)));
   }
   if(!d?.ok)throw new Error(dreaminaReason(d,'The finished image could not be downloaded from Dreamina.'));
   const credits=Number(r.data?.quote?.maxCredits);
   return {bytes:await readFile(file),model:request.model,credits:Number.isFinite(credits)?credits:undefined,submitId:typeof sub?.submitId==='string'?sub.submitId:undefined};
  },
 };
}

import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import type {EventEmitter} from 'node:events';
import {join} from 'node:path';
import {collectProbe,resultBytes,probeErrorDetail} from '../scripts/codex-subscription-image-probe';
import {resolveProbeRuntime,requireImageRuntime,probeServerArgs,type ProbeRuntime} from '../scripts/codex-probe-runtime';

export const CHATGPT_IMAGE_MODEL='gpt-6.1-sol';
export type NativeAccount={connected:boolean;email?:string;plan?:string};
export type NativeLogin={loginId:string;verificationUrl:string;userCode:string;close:()=>Promise<void>};
export type NativeImage={bytes:Buffer;model:string;runtime:string};
export interface ChatgptNative {
 status(home:string):Promise<NativeAccount>;
 login(home:string,complete:(ok:boolean)=>void):Promise<NativeLogin>;
 logout(home:string):Promise<void>;
 edit(home:string,cwd:string,paths:string[],prompt:string,signal:AbortSignal):Promise<NativeImage>;
}
/** Only operating-system launch necessities survive. No desktop account, API keys or provider routes. */
export function nativeImageEnv(home:string,env:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
 const allowed=['PATH','Path','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','USERPROFILE','HOME','LOCALAPPDATA','APPDATA'];
 return {...Object.fromEntries(allowed.filter(k=>env[k]!==undefined).map(k=>[k,env[k]])),CODEX_HOME:home};
}
const stopping=new WeakMap<ChildProcessWithoutNullStreams,Promise<void>>();
export function stopNative(child:ChildProcessWithoutNullStreams){const existing=stopping.get(child);if(existing)return existing;const work=stopChild(child);stopping.set(child,work);return work;}
async function stopChild(child:ChildProcessWithoutNullStreams){
 child.stdin.end();
 if(process.platform==='win32'&&child.pid)await new Promise<void>(resolve=>{const p=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});p.once('exit',()=>resolve());p.once('error',()=>resolve());});
 else if(child.exitCode===null){await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},1000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});}
}
/** Small account-only RPC client. No inference methods are accepted on this interface. */
export class NativeAccountRpc {
 private next=1;private buffer='';private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 private stopped=false;
 onLogin:(id:string,ok:boolean)=>void=()=>{};
 constructor(readonly child:ChildProcessWithoutNullStreams){
  child.stdin.on('error',()=>{});child.stderr.resume();child.on('error',()=>this.fail());child.on('exit',()=>this.fail());
  (child.stdout as EventEmitter).on('data',(chunk:Buffer|string)=>{this.buffer+=String(chunk);if(Buffer.byteLength(this.buffer)>1024*1024){this.fail();return;}
   for(let end=this.buffer.indexOf('\n');end>=0;end=this.buffer.indexOf('\n')){let m:any;try{m=JSON.parse(this.buffer.slice(0,end));}catch{this.fail();return;}this.buffer=this.buffer.slice(end+1);
    if(m.id!==undefined){if(m.method){this.fail();return;}const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(new Error('Native ChatGPT account request failed.')):p.resolve(m.result);}}
    else if(m.method==='account/login/completed')this.onLogin(m.params?.loginId,m.params?.success===true);
   }
  });
 }
 private fail(){if(this.stopped)return;this.stopped=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Native ChatGPT account process stopped.'));}this.pending.clear();void stopNative(this.child);}
 request(method:string,params:unknown={}){if(!['initialize','account/read','account/login/start','account/login/cancel','account/logout'].includes(method))return Promise.reject(new Error('Account RPC cannot start inference.'));
  if(this.stopped)return Promise.reject(new Error('Native ChatGPT account process stopped.'));
  return new Promise<any>((resolve,reject)=>{const id=this.next++,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('ChatGPT account request timed out.'));},15000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
 async initialize(){await this.request('initialize',{clientInfo:{name:'comfyfield',title:'ComfyField',version:'0.1.0'},capabilities:{experimentalApi:true}});this.child.stdin.write(JSON.stringify({method:'initialized'})+'\n');}
}
/** Native CLI handles OAuth and refresh tokens. Never reads/copies the global desktop auth.json. */
export function createChatgptNative():ChatgptNative {
 let runtime:Promise<ProbeRuntime>|undefined;
 async function launch(home:string,cwd=home){const selected=await(runtime??=resolveProbeRuntime().catch(e=>{runtime=undefined;throw e;}));requireImageRuntime(selected);
  const child=spawn(selected.bin,[...selected.prefix,...probeServerArgs([])],{cwd,env:nativeImageEnv(home),windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});child.stdin.on('error',()=>{});child.stderr.resume();return {child,selected};}
 async function accountCall<T>(home:string,work:(rpc:NativeAccountRpc)=>Promise<T>){const {child}=await launch(home);try{const rpc=new NativeAccountRpc(child);await rpc.initialize();return await work(rpc);}finally{await stopNative(child);}}
 return {
  status:home=>accountCall(home,async rpc=>{const value=await rpc.request('account/read',{refreshToken:false}),a=value?.account;return a?.type==='chatgpt'?{connected:true,email:typeof a.email==='string'?a.email:undefined,plan:typeof a.planType==='string'?a.planType:undefined}:{connected:false};}),
  async login(home,complete){const {child}=await launch(home),rpc=new NativeAccountRpc(child);let closed=false,loginId='';const close=async()=>{if(closed)return;closed=true;await stopNative(child);};
   try{await rpc.initialize();rpc.onLogin=(id,ok)=>{if(id===loginId){complete(ok);void close();}};const r=await rpc.request('account/login/start',{type:'chatgptDeviceCode'});
    const url=new URL(r.verificationUrl);if(r.type!=='chatgptDeviceCode'||!['auth.openai.com','chatgpt.com'].includes(url.hostname)||url.protocol!=='https:'||url.username||url.password||!r.loginId||typeof r.userCode!=='string'||r.userCode.length>100)throw new Error('Invalid native sign-in response.');
    loginId=r.loginId;return {loginId,verificationUrl:url.href,userCode:r.userCode,close:async()=>{try{if(!closed)await rpc.request('account/login/cancel',{loginId});}finally{await close();}}};
   }catch(e){await close();throw e;}
  },
  logout:home=>accountCall(home,async rpc=>{await rpc.request('account/logout');}),
  async edit(home,cwd,paths,prompt,signal){const {child,selected}=await launch(home,cwd),started=Date.now();const abort=()=>{void stopNative(child);};signal.addEventListener('abort',abort,{once:true});
   try{const r=await collectProbe(child,cwd,paths[0],{model:CHATGPT_IMAGE_MODEL,prompt,inputPaths:paths,signal},120000);
    return {bytes:await resultBytes(r.image.result,[cwd,join(home,'generated_images')],started),model:r.model,runtime:selected.version};
   }catch(e){const reason=probeErrorDetail({message:(e as Error).message})??'Image editing failed.';throw new Error(reason);}
   finally{signal.removeEventListener('abort',abort);await stopNative(child);}
  },
 };
}

/** Experimental, opt-in capability probe. Not registered as a ComfyField render provider. */
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {readFile,writeFile,mkdir,realpath,stat} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import type {Readable,Writable} from 'node:stream';
import type {EventEmitter} from 'node:events';
import sharp from 'sharp';
import {resolveProbeRuntime,requireImageRuntime,probeServerArgs,sanitizedProbeEnvironment} from './codex-probe-runtime';

type Message={id?:number|string;method?:string;params?:any;result?:any;error?:unknown};
export type ProbeChild={stdin:Writable;stdout:Readable;on:(event:string,callback:()=>void)=>unknown;off?:(event:string,callback:()=>void)=>unknown};
export type ProbeResult={model:string;image:{id:string;status:string;result:string};threadId:string};
export type ProbeEvent={event:string;method?:string;code?:number;model?:string;status?:string;detail?:string};
export type ProbeMetadata={accountType:'chatgpt';rateLimitsReadable:boolean;models:{id:string;model:string;isDefault:boolean}[];threadStarts:0;inferenceTurns:0};
/** Retain bounded native error evidence without credentials or account identifiers. */
export function probeErrorDetail(error:unknown):string|undefined{
 if(!error||typeof error!=='object')return undefined;
 const e=error as Record<string,unknown>,parts=[e.message,e.additionalDetails,typeof e.codexErrorInfo==='string'?e.codexErrorInfo:e.codexErrorInfo?JSON.stringify(e.codexErrorInfo):undefined].filter(v=>typeof v==='string') as string[];
 if(!parts.length)return undefined;
 return parts.join(' · ').replace(/Bearer\s+[^\s"',;]+/gi,'Bearer [redacted]').replace(/\b(?:sk-|comfyui-)[A-Za-z0-9_-]+/g,'[redacted]').replace(/((?:access_token|refresh_token|id_token|api_key|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,'$1[redacted]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted email]').slice(0,2000);
}
export function probeThread(cwd:string,model:string){return {ephemeral:true,cwd,model,approvalPolicy:'never',sandbox:'read-only',modelProvider:'openai',baseInstructions:'This is one isolated capability test. Use only the native image generation tool to edit the provided image exactly once. No shell, MCP, agents, code, API clients, alternative providers or retries. If the native tool is unavailable, say so and stop.',config:{'features.image_generation':true,'features.shell_tool':false,'features.multi_agent':false,web_search:'disabled'}};}
export const probeEnvironment=sanitizedProbeEnvironment;
export function disabledMcpArgs(config:string):string[]{
 if(/model_providers\."?openai[".\]]|^\s*(?:chatgpt_base_url|model_providers)\s*=/m.test(config))throw new Error('Custom native provider routing needs review before a subscription probe.');
 const names=new Set<string>();
 for(const line of config.split(/\r?\n/)){
  if(/^\s*\[mcp_servers\]\s*(?:#.*)?$/.test(line))throw new Error('Inline MCP config needs explicit review before this isolated probe.');
  const match=line.match(/^\s*\[mcp_servers\.("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)(?:\.|\])/);
  if(match){const name=match[1].startsWith('"')?JSON.parse(match[1]):match[1];if(!/^[A-Za-z0-9_-]{1,100}$/.test(name))throw new Error('Unsupported MCP name in probe config.');names.add(name);}
  else if(/^\s*\[mcp_servers\./.test(line))throw new Error('MCP config could not be safely disabled.');
 }
 return [...names].flatMap(name=>['-c',`mcp_servers.${name}.enabled=false`]);
}
type MetadataOptions={inspectOnly:true};
type ImageOptions={model:string;inspectOnly?:false;prompt?:string;inputPaths?:string[];signal?:AbortSignal};
export function collectProbe(child:ProbeChild,cwd:string,inputPath:string,options:MetadataOptions,timeoutMs?:number,observe?:(event:ProbeEvent)=>void):Promise<ProbeMetadata>;
export function collectProbe(child:ProbeChild,cwd:string,inputPath:string,options:ImageOptions,timeoutMs?:number,observe?:(event:ProbeEvent)=>void):Promise<ProbeResult>;
/** Metadata mode exits before thread creation. Live mode requires an explicit catalog-listed model and never falls back. */
export async function collectProbe(child:ProbeChild,cwd:string,inputPath:string,options:MetadataOptions|ImageOptions,timeoutMs=120000,observe:(event:ProbeEvent)=>void=()=>{}):Promise<ProbeResult|ProbeMetadata>{
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw new Error('Probe timeout must be at most two minutes.');
 if(!options.inspectOnly&&(!options.model||!options.model.trim()))throw new Error('An explicitly approved --model is required before a subscription probe.');
 if(!options.inspectOnly&&options.signal?.aborted)throw new Error('Image edit canceled.');
 let next=1,buffer='',threadId='',done=false;const images=new Map<string,any>(),pending=new Map<number,{method:string;resolve:(r:any)=>void;reject:(e:Error)=>void}>();
 let finish:(r:ProbeResult)=>void=()=>{},rejectTurn:(e:Error)=>void=()=>{};
 const completed=new Promise<ProbeResult>((res,rej)=>{finish=res;rejectTurn=rej;});void completed.catch(()=>{});
 const fail=(error:Error)=>{if(done)return;done=true;for(const p of pending.values())p.reject(error);pending.clear();rejectTurn(error);};
 const request=(method:string,params:unknown)=>new Promise<any>((res,rej)=>{if(done){rej(new Error('Probe stopped.'));return;}const id=next++;pending.set(id,{method,resolve:res,reject:rej});observe({event:'request',method});child.stdin.write(`${JSON.stringify({id,method,params})}\n`);});
 const inspect=(item:any)=>{if(item?.type!=='imageGeneration')return;
  if(item.failure){const detail=probeErrorDetail({message:JSON.stringify(item.failure)});observe({event:'image_failed',detail});fail(new Error(`Native image generation failed. ${detail??''}`));return;}
  if(typeof item.id!=='string'||!['completed','succeeded','success'].includes(item.status))return;
  const result=typeof item.savedPath==='string'&&item.savedPath?item.savedPath:item.result;
  if(typeof result!=='string'||!result){fail(new Error('Native image result has no supported local path or encoded bytes; attachment-only output remains unverified.'));return;}
  images.set(item.id,{...item,result});if(images.size>1)fail(new Error('More than one image result; probe rejected.'));};
 const data=(chunk:Buffer|string)=>{
  buffer+=chunk.toString();if(Buffer.byteLength(buffer)>24*1024*1024){fail(new Error('Probe response exceeded the size bound.'));return;}
  for(let end=buffer.indexOf('\n');end>=0;end=buffer.indexOf('\n')){let m:Message;try{m=JSON.parse(buffer.slice(0,end));}catch{fail(new Error('Malformed Codex protocol response.'));return;}buffer=buffer.slice(end+1);
   if(m.id!==undefined){if(m.method){fail(new Error('Unexpected tool/approval request; probe stopped.'));return;}const p=pending.get(Number(m.id));if(p){pending.delete(Number(m.id));if(m.error){observe({event:'rpc_error',method:p.method,code:typeof (m.error as any).code==='number'?(m.error as any).code:undefined,detail:probeErrorDetail(m.error)});p.reject(new Error(`Codex rejected ${p.method}.`));}else {observe({event:'response',method:p.method});p.resolve(m.result);}}continue;}
   if(!threadId||m.params?.threadId!==threadId)continue;
   if(m.method==='error')observe({event:'native_error',detail:probeErrorDetail(m.params.error)});
   if(m.params?.item?.type==='imageGeneration'&&['item/started','item/completed'].includes(m.method??''))observe({event:m.method!,status:String(m.params.item.status??'')});
   if(m.method==='turn/completed')observe({event:'turn/completed',status:String(m.params.turn?.status??''),detail:probeErrorDetail(m.params.turn?.error)});
   if(m.method==='item/completed')inspect(m.params.item);
   if(m.method==='turn/completed'){const turn=m.params.turn;if(turn?.status!=='completed'){const detail=probeErrorDetail(turn?.error);fail(new Error(`Codex image turn failed or was interrupted.${detail?` ${detail}`:''}`));return;}for(const item of turn.items??[])inspect(item);if(done)return;if(images.size!==1){fail(new Error('No completed native imageGeneration result; capability remains unverified.'));return;}finish({model:'not reported',threadId,image:[...images.values()][0]});}
  }
 };
 const exit=()=>fail(new Error('Codex exited before the image probe completed.'));
 const abort=()=>fail(new Error('Image edit canceled.'));
 if(!options.inspectOnly)options.signal?.addEventListener('abort',abort,{once:true});
 (child.stdout as EventEmitter).on('data',data);child.on('exit',exit);child.on('error',exit);
 const timer=setTimeout(()=>fail(new Error('Two-minute probe limit reached; no retry.')),timeoutMs);
 try{
  await request('initialize',{clientInfo:{name:'comfyfield_image_probe',title:'ComfyField image capability probe',version:'0.1.0'},capabilities:{experimentalApi:true}});child.stdin.write(`${JSON.stringify({method:'initialized'})}\n`);
  const account=await request('account/read',{refreshToken:false});if(account?.account?.type!=='chatgpt')throw new Error('A native ChatGPT Codex sign-in is required; no API-key fallback.');
  observe({event:'account_verified',status:'chatgpt'});
  await request('account/rateLimits/read',{});
  const catalog=await request('model/list',{limit:100});
  if(!Array.isArray(catalog?.data)||catalog.data.length>100||catalog.nextCursor)throw new Error('Model catalog is incomplete; no model turn started.');
  const models=catalog.data.filter((m:any)=>typeof m.id==='string'&&typeof m.model==='string').map((m:any)=>({id:m.id,model:m.model,isDefault:m.isDefault===true}));
  if(options.inspectOnly)return {accountType:'chatgpt',rateLimitsReadable:true,models,threadStarts:0,inferenceTurns:0};
  if(!models.some((m:ProbeMetadata['models'][number])=>m.model===options.model))throw new Error('Explicit model is absent from the selected runtime catalog; no thread or turn started.');
  observe({event:'preflight_passed',model:options.model});
  const started=await request('thread/start',probeThread(cwd,options.model));threadId=started?.thread?.id;if(!threadId)throw new Error('Codex did not create an isolated thread.');
  if(typeof started.model!=='string'||!started.model)throw new Error('Codex did not report the selected model; no turn started.');
  observe({event:'thread_created',model:started.model});
  if(started.model!==options.model)throw new Error('Native selected model differs from the explicitly approved model; no turn started.');
  await request('turn/start',{threadId,effort:'low',input:[{type:'text',text:options.prompt?`Edit image 1 according to this request. Additional images are references in the supplied order. Use the native image generation tool exactly once and return exactly one image. Do not use alternatives, shell, code, agents or MCP. Request: ${options.prompt}`:'Edit the supplied test image: change the blue square to orange. Keep the white background and square shape. Generate exactly one image with the native image generation tool and stop. If unavailable, stop without alternatives.'},...(options.inputPaths??[inputPath]).map(path=>({type:'localImage',path}))]});
  const result=await completed;if(done)throw new Error('Probe stopped before collection.');return {...result,model:started.model};
 }finally{clearTimeout(timer);if(!options.inspectOnly)options.signal?.removeEventListener('abort',abort);(child.stdout as EventEmitter).off('data',data);child.off?.('exit',exit);child.off?.('error',exit);fail(new Error('Probe closed.'));}
}
export async function resultBytes(result:string,roots:string[],startedAt:number):Promise<Buffer>{
 const encoded=result.replace(/^data:image\/(?:png|jpeg|webp);base64,/,'');
 if(encoded.length<=24*1024*1024&&/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)&&encoded.length%4===0)return Buffer.from(encoded,'base64');
 if(!isAbsolute(result))throw new Error('Unknown image result representation; no guess or remote fetch.');
 const path=await realpath(result),allowed=await Promise.all(roots.map(async root=>realpath(root).catch(()=>resolve(root))));
 if(!allowed.some(root=>{const rel=relative(root,path);return rel&&!rel.startsWith('..')&&!isAbsolute(rel);}))throw new Error('Image result is outside permitted output folders.');
 const info=await stat(path);if(!info.isFile()||info.size>18*1024*1024||info.mtimeMs<startedAt-1000)throw new Error('Image result is oversized or predates this probe.');return readFile(path);
}
async function stopChild(child:ChildProcessWithoutNullStreams){
 if(process.platform==='win32'&&child.pid){await new Promise<void>(res=>{const stop=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});stop.once('exit',()=>res());stop.once('error',()=>res());});}
 else child.kill('SIGTERM');
}
async function main(){
 const inspectOnly=process.argv.includes('--inspect-only'),run=process.argv.includes('--run-subscription-probe');
 if(!inspectOnly&&!run){console.log('Offline prototype only. No Codex process started. --inspect-only reads metadata without inference. A live test requires scoped approval, --run-subscription-probe and --model <id>.');return;}
 if(inspectOnly&&run)throw new Error('Choose metadata inspection or one image probe, never both.');
 const modelIndex=process.argv.indexOf('--model'),model=modelIndex>=0?process.argv[modelIndex+1]:undefined;
 if(run&&(!model||model.startsWith('--')))throw new Error('An explicitly approved --model is required; no process started.');
 const home=process.env.CODEX_HOME?.trim()||join(homedir(),'.codex'),config=await readFile(join(home,'config.toml'),'utf8').catch(()=>''),args=probeServerArgs(disabledMcpArgs(config));
 const runtime=await resolveProbeRuntime();requireImageRuntime(runtime);
 const root=join(tmpdir(),`codex-${inspectOnly?'metadata-check':'image-probe'}-${Date.now()}`);await mkdir(root,{recursive:true});
 const input=join(root,'input.png');if(run)await sharp({create:{width:256,height:256,channels:3,background:'white'}}).composite([{input:Buffer.from('<svg width="256" height="256"><rect x="64" y="64" width="128" height="128" fill="blue"/></svg>')}]).png().toFile(input);
 const child=spawn(runtime.bin,[...runtime.prefix,...args],{cwd:root,windowsHide:true,shell:false,env:probeEnvironment(process.env),stdio:['pipe','pipe','pipe']});child.stdin.on('error',()=>{});child.stderr.resume();const started=Date.now(),events:ProbeEvent[]=[];
 await writeFile(join(root,'launch.json'),JSON.stringify({pid:child.pid,startedAt:started,root,runtime,mode:inspectOnly?'metadata':'image',requestedModel:model},null,2));console.log(JSON.stringify({event:inspectOnly?'inspection_started':'probe_started',pid:child.pid,root,runtime}));
 try{
  const observe=(event:ProbeEvent)=>{if(events.length<100)events.push(event);};
  if(inspectOnly){const receipt={runtime,...await collectProbe(child,root,'',{inspectOnly:true},20000,observe),events};await writeFile(join(root,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));return;}
  const r=await collectProbe(child,root,input,{model:model!},120000,observe);const bytes=await resultBytes(r.image.result,[root,join(home,'generated_images')],started);const image=sharp(bytes,{limitInputPixels:4096*4096}),meta=await image.metadata();if(!['png','jpeg','webp'].includes(meta.format??''))throw new Error('Result is not a supported encoded image.');await image.stats();const output=join(root,`output.${meta.format==='jpeg'?'jpg':meta.format}`);await writeFile(output,bytes,{flag:'wx'});const receipt={experimental:true,runtime,model:r.model,nativeAccount:'chatgpt',output,width:meta.width,height:meta.height,sha256:createHash('sha256').update(bytes).digest('hex'),elapsedMs:Date.now()-started,events,limits:'One turn, two-minute timeout, no retries. Not a billing/plan eligibility guarantee.'};await writeFile(join(root,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));}
 catch(error){const receipt={experimental:true,status:'failed',reason:(error as Error).message,elapsedMs:Date.now()-started,events};await writeFile(join(root,'failure.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));throw error;}
 finally{child.stdin.end();await stopChild(child);await writeFile(join(root,'cleanup.json'),JSON.stringify({pid:child.pid,terminationRequested:true},null,2));}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(e=>{console.error((e as Error).message);process.exitCode=1;});

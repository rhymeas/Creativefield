/* Fixture worker: a stand-in ComfyUI for feature development. It speaks the HTTP subset ComfyField uses
   (upload, prompt, queue, history, view, cancel, free, system_stats, object_info, models) and answers every
   prompt with placeholder media after a short delay, so UI and run flows can be built without loading models.
   Node and model lists come from a snapshot of the real ComfyUI, so readiness checks behave the same.
   Start: npm run fixture-worker. Point the app at it: npm run worker:fixture (back: npm run worker:local). */
import {createServer,type IncomingMessage,type ServerResponse} from "node:http";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {copyFile,mkdir,readFile,stat,writeFile} from "node:fs/promises";
import {basename,extname,join,resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {cubeGlb,fixtureMode,fixtureOutputs,graphSize,graphTiming,loadedImage,parseMultipart,type FixtureMedia} from "./fixture-worker-lib";

const PORT=Number(process.env.FIXTURE_PORT??8191);
const REAL=process.env.FIXTURE_REAL_COMFY??"http://127.0.0.1:8188";
const DELAY_MS=Number(process.env.FIXTURE_DELAY_MS??4000);
const ROOT=resolve(process.env.FIXTURE_ROOT??".comfyfield/fixture-worker");
const INPUT=join(ROOT,"input"),OUTPUT=join(ROOT,"output"),SNAPSHOT=join(ROOT,"snapshot.json");
const run=promisify(execFile);

type Job={id:string;number:number;tuple:unknown[];created:number;duration:number;mode:"fail"|"slow"|"normal";canceled?:boolean;error?:string;outputs?:Record<string,Record<string,unknown>>};
const jobs=new Map<string,Job>();
let counter=0;
let snapshot:{objectInfo:Record<string,unknown>;models:string[];folders:Record<string,string[]>}={objectInfo:{},models:[],folders:{}};

/** Copies node and model lists from the real ComfyUI when it is up; otherwise reuses the last copy. */
async function loadSnapshot(){
  try{
    const get=async(path:string)=>{const r=await fetch(`${REAL}${path}`,{signal:AbortSignal.timeout(30_000)});if(!r.ok)throw new Error(path);return r.json();};
    const objectInfo=await get("/object_info") as Record<string,unknown>,models=await get("/models") as string[],folders:Record<string,string[]>={};
    for(const folder of models)folders[folder]=await get(`/models/${encodeURIComponent(folder)}`).catch(()=>[]) as string[];
    snapshot={objectInfo,models,folders};await writeFile(SNAPSHOT,JSON.stringify(snapshot));
    console.log(`snapshot taken from ${REAL}: ${Object.keys(objectInfo).length} nodes, ${models.length} model folders`);
  }catch{
    try{snapshot=JSON.parse(await readFile(SNAPSHOT,"utf8"));console.log(`real ComfyUI unreachable; using the saved snapshot (${Object.keys(snapshot.objectInfo).length} nodes)`);}
    catch{console.log("no snapshot yet: readiness checks will report missing nodes until the real ComfyUI has been reachable once");}
  }
}

const exists=(file:string)=>stat(file).then(()=>true,()=>false);

/** Placeholder media is rendered once per size at first use and copied after that, so a run needs no encoder. */
const BASE=join(ROOT,"base");
async function baseFile(media:Exclude<FixtureMedia,"model3d">,width:number,height:number,timing:{frames:number;fps:number}):Promise<string>{
  const file=join(BASE,media==="audio"?"tone.flac":media==="video"?`video-${width}x${height}-${timing.frames}f${timing.fps}.mp4`:`image-${width}x${height}.png`);
  if(await exists(file))return file;
  const args=media==="audio"?["-f","lavfi","-i","sine=frequency=440:duration=2","-ac","1"]
    :media==="video"?["-f","lavfi","-i",`testsrc2=size=${width}x${height}:rate=${timing.fps}`,"-frames:v",String(timing.frames),"-pix_fmt","yuv420p","-c:v","libx264"]
    :["-f","lavfi","-i",`testsrc2=size=${width}x${height}`,"-frames:v","1"];
  await run("ffmpeg",["-y","-loglevel","error",...args,file]);
  return file;
}

/** Writes one placeholder file for an output node and returns its name in the output folder. */
async function makeOutput(job:Job,media:FixtureMedia,graph:Record<string,any>,index:number):Promise<string>{
  const stem=`fixture_${job.id.slice(0,8)}_${String(index+1).padStart(5,"0")}_`;
  const {width,height}=graphSize(graph);
  if(media==="model3d"){const name=`${stem}.glb`;await writeFile(join(OUTPUT,name),cubeGlb());return name;}
  // An edit returns its source unchanged (same bytes, same extension), so the result looks like the input.
  const source=loadedImage(graph),input=source&&join(INPUT,basename(source));
  if(media==="image"&&input&&await exists(input)){const name=`${stem}${extname(input)||".png"}`;await copyFile(input,join(OUTPUT,name));return name;}
  const base=await baseFile(media,width,height,graphTiming(graph)),name=`${stem}${extname(base)}`;
  await copyFile(base,join(OUTPUT,name));return name;
}

/** Jobs advance by the clock: pending for a moment, running for the delay, then done. Outputs are written once. */
async function settle(job:Job){
  if(job.outputs||job.error||job.canceled||job.mode==="fail"||Date.now()<job.created+job.duration)return;
  const graph=job.tuple[2] as Record<string,any>,outputs:Record<string,Record<string,unknown>>={};
  try{
    for(const [i,out] of fixtureOutputs(graph).entries()){
      const filename=await makeOutput(job,out.media,graph,i);
      outputs[out.node]={[out.key]:[{filename,subfolder:"",type:"output"}],...(out.media==="video"?{animated:[true]}:{})};
    }
    job.outputs=outputs;
  }catch(error){
    // A job whose outputs cannot be written ends as an error, like a failed node in ComfyUI, instead of never finishing.
    job.error=`fixture output failed: ${(error as Error).message.split("\n")[0]}`;console.error(job.error);
  }
}
const done=(job:Job)=>job.canceled||Date.now()>=job.created+job.duration;
function historyEntry(job:Job){
  const failed=job.mode==="fail"||!!job.error,status_str=job.canceled||failed?"error":"success";
  const messages=job.canceled?[["execution_interrupted",{prompt_id:job.id}]]:failed?[["execution_error",{prompt_id:job.id,exception_message:job.error??"fixture:fail requested"}]]:[["execution_success",{prompt_id:job.id}]];
  return {prompt:job.tuple,outputs:job.outputs??{},status:{status_str,completed:!job.canceled&&!failed,messages}};
}
async function history(limit=1000){
  const out:Record<string,unknown>={};
  for(const job of [...jobs.values()].slice(-limit)){if(!done(job))continue;await settle(job);out[job.id]=historyEntry(job);}
  return out;
}

const send=(res:ServerResponse,code:number,body:unknown)=>{res.writeHead(code,{"content-type":"application/json"});res.end(JSON.stringify(body));};
async function body(req:IncomingMessage){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);return Buffer.concat(chunks);}

async function handle(req:IncomingMessage,res:ServerResponse){
  const url=new URL(req.url??"/","http://fixture"),path=url.pathname.replace(/^\/api(?=\/)/,""),method=req.method??"GET";
  if(path==="/system_stats")return send(res,200,{system:{os:"fixture",comfyui_version:"fixture",python_version:"",ram_total:64e9,ram_free:48e9},devices:[]});
  if(path==="/object_info")return send(res,200,snapshot.objectInfo);
  if(path.startsWith("/object_info/")){const name=decodeURIComponent(path.slice(13)),info=snapshot.objectInfo[name];return info?send(res,200,{[name]:info}):send(res,404,{});}
  if(path==="/models")return send(res,200,snapshot.models);
  if(path.startsWith("/models/"))return send(res,200,snapshot.folders[decodeURIComponent(path.slice(8))]??[]);
  if(path==="/free"&&method==="POST")return send(res,200,{});
  if(path==="/upload/image"&&method==="POST"){
    const parts=parseMultipart(await body(req),req.headers["content-type"]??""),file=parts.find(p=>p.name==="image"&&p.filename);
    if(!file)return send(res,400,{error:"image missing"});
    const name=basename(file.filename!);await writeFile(join(INPUT,name),file.data);
    return send(res,200,{name,subfolder:"",type:"input"});
  }
  if(path==="/prompt"&&method==="POST"){
    const request=JSON.parse((await body(req)).toString("utf8")),graph=request.prompt;
    if(!graph||typeof graph!=="object")return send(res,400,{error:{type:"invalid_prompt",message:"prompt missing"},node_errors:{}});
    const id=randomUUID(),mode=fixtureMode(graph),number=counter++;
    jobs.set(id,{id,number,tuple:[number,id,graph,request.extra_data??{},fixtureOutputs(graph).map(o=>o.node)],created:Date.now(),duration:mode==="slow"?30_000:DELAY_MS,mode});
    console.log(`prompt ${id.slice(0,8)} (${mode}) with ${fixtureOutputs(graph).map(o=>`${o.media}@${o.node}`).join(", ")||"no outputs"}`);
    return send(res,200,{prompt_id:id,number,node_errors:{}});
  }
  if(path==="/queue"&&method==="GET"){
    const open=[...jobs.values()].filter(job=>!done(job)),started=(job:Job)=>Date.now()>=job.created+500;
    return send(res,200,{queue_running:open.filter(started).map(j=>j.tuple),queue_pending:open.filter(j=>!started(j)).map(j=>j.tuple)});
  }
  if(path==="/queue"&&method==="POST"){const {delete:ids=[]}=JSON.parse((await body(req)).toString("utf8")||"{}");for(const id of ids){const job=jobs.get(id);if(job&&!done(job))job.canceled=true;}return send(res,200,{});}
  if(path==="/interrupt"&&method==="POST"){for(const job of jobs.values())if(!done(job))job.canceled=true;return send(res,200,{});}
  const cancel=/^\/jobs\/([^/]+)\/cancel$/.exec(path);
  if(cancel&&method==="POST"){const job=jobs.get(decodeURIComponent(cancel[1]));const ok=!!job&&!done(job);if(ok)job!.canceled=true;return send(res,200,{cancelled:ok});}
  if(path==="/history")return send(res,200,await history(Number(url.searchParams.get("max_items")??1000)));
  if(path.startsWith("/history/")){const job=jobs.get(decodeURIComponent(path.slice(9)));if(!job||!done(job))return send(res,200,{});await settle(job);return send(res,200,{[job.id]:historyEntry(job)});}
  if(path==="/view"){
    const name=basename(url.searchParams.get("filename")??""),dir=url.searchParams.get("type")==="input"?INPUT:OUTPUT,file=join(dir,name);
    if(!name||url.searchParams.get("subfolder")||!await exists(file))return send(res,404,{});
    res.writeHead(200,{"content-type":"application/octet-stream"});res.end(await readFile(file));return;
  }
  send(res,404,{error:"not available on the fixture worker"});
}

await mkdir(INPUT,{recursive:true});await mkdir(OUTPUT,{recursive:true});await mkdir(BASE,{recursive:true});
await loadSnapshot();
createServer((req,res)=>{handle(req,res).catch(error=>{console.error(error);if(!res.headersSent)send(res,500,{error:String(error)});});})
  .listen(PORT,"127.0.0.1",()=>console.log(`fixture worker on http://127.0.0.1:${PORT} (delay ${DELAY_MS} ms; "fixture:fail" / "fixture:slow" in a prompt steer it)`));

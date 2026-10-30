import type {Pool} from "pg";
import type {CapabilityBundle,WorkerInventory} from "../src/capabilities/types";
import type {ProbedInventory} from "../src/capabilities/readiness";
import {parseWorkerHardware} from "../src/capabilities/hardware";
import {MIN_FREE_RAM_SHARE} from "./memory-guard";
import {comfyCloudKey} from "./config";
import {hashToken} from "./crypto";
import type {CloudSubmitAccess} from "./cloud-readiness";

/** A probed inventory plus what the probe learned about the key's own account. */
export type ProbedCloudInventory = ProbedInventory & CloudSubmitAccess;

/** What a model file is called, so a list of sampler names is not read as a list of files. */
const MODEL_FILE=/\.(safetensors|sft|ckpt|pth|pt|bin|onnx|gguf)$/i;

/**
 * The model files Comfy Cloud offers, read from its own node list. Cloud has no /models folder
 * endpoint, so the loaders' own option lists are the only place its files show up. A list with
 * no file in it says nothing about files, so the answer is nothing rather than an empty one:
 * readiness then leaves models unchecked instead of calling every file missing.
 */
export function cloudModelFiles(info:unknown):string[]|undefined{
  const files=new Set<string>();
  for(const node of Object.values((info??{}) as Record<string,unknown>)){
    const inputs=(node as {input?:{required?:Record<string,unknown>;optional?:Record<string,unknown>}}|null)?.input;
    for(const group of [inputs?.required,inputs?.optional])for(const spec of Object.values(group??{})){
      const values=Array.isArray(spec)?spec[0]:undefined;
      if(!Array.isArray(values))continue;
      for(const value of values)if(typeof value==="string"&&MODEL_FILE.test(value))files.add(value);
    }
  }
  return files.size?[...files].sort():undefined;
}

/** The key from the environment, or nothing when it is unset. The key is never stored here. */
function cloudKey():string|undefined{
  try{return comfyCloudKey()||undefined;}catch{return undefined;}
}
function cloudHeaders():Record<string,string>{
  const key=cloudKey();
  return key?{Authorization:`Bearer ${key}`}:{};
}

/** The sentence Cloud puts in an error body, or nothing when it sent none. */
function cloudSentence(text:string):string|undefined{
  try{
    const body=JSON.parse(text) as {error?:{message?:unknown}|string};
    const message=typeof body?.error==="string"?body.error:typeof body?.error?.message==="string"?body.error.message:undefined;
    return message?.replace(/\s+/g," ").trim().slice(0,240)||undefined;
  }catch{return undefined;}
}

/**
 * The smallest graph Comfy Cloud validates and then judges by plan: one string, handed to
 * PreviewAny so the graph has an output. Nothing in it needs a GPU. Read live on 2026-10-27:
 * an empty graph never reaches the plan check (it stops at `400 VALIDATION_ERROR "Prompt has no
 * outputs"`), so a 400 says nothing about the plan and cannot be read as permission.
 */
const SUBMIT_PROBE_GRAPH={ "1":{class_type:"PrimitiveString",inputs:{value:"ping"}},"2":{class_type:"PreviewAny",inputs:{source:["1",0]}} };

/** One answer about a key is reused this long. The probe is a real submit — refused in full on a
 *  free tier, a no-GPU job on a paid plan — so it is asked once an hour per key, never per page
 *  load or per minute-long worker probe. */
const SUBMIT_ACCESS_MS=60*60*1000;
/** The answers already known, by cloud origin, prefix and a hash of the key (never the key). */
const submitAccessCache=new Map<string,{at:number;access:CloudSubmitAccess}>();

/**
 * Whether this key's account may SUBMIT a run at all. A free-tier Comfy Cloud account reads,
 * uploads and probes fine (the node probe says ready) and answers every submitted run with a
 * 403, so the answer is asked for with one submit of the smallest graph Cloud can validate:
 *
 * - a free-tier account is refused with the cloud's own sentence (403);
 * - an account that may submit takes the graph, which runs a tiny job with no GPU work;
 * - a `400` / `422` is a complaint about the graph, not about the plan, so it proves nothing.
 *
 * Anything else — no key, a 5xx, a rate limit, a refused connection — leaves the answer unknown
 * rather than guessing, and the caller keeps what it knew before. Only a real answer is kept, so
 * a blip is retried on the next probe.
 */
export async function probeSubmitAccess(worker:{origin:string;api_prefix:string}):Promise<CloudSubmitAccess>{
  const key=cloudKey();
  if(!key)return {};
  const cacheKey=`${worker.origin}\u0000${worker.api_prefix}\u0000${hashToken(key)}`;
  const cached=submitAccessCache.get(cacheKey);
  if(cached&&Date.now()-cached.at<SUBMIT_ACCESS_MS)return cached.access;
  let response:Response;
  try{
    response=await fetch(`${worker.origin}${worker.api_prefix}/prompt`,{method:"POST",headers:{...cloudHeaders(),"X-API-KEY":key,"Content-Type":"application/json"},body:JSON.stringify({prompt:SUBMIT_PROBE_GRAPH}),signal:AbortSignal.timeout(15000),redirect:"error"});
  }catch{return {};}
  const text=await response.text().catch(()=>"");
  const access:CloudSubmitAccess|undefined=response.status===403
    ?{canSubmit:false,submitBlockedReason:cloudSentence(text)??"Comfy Cloud refused a run from this API key (HTTP 403)"}
    :response.ok?{canSubmit:true}:undefined;
  if(!access)return {};
  const now=Date.now();
  for(const [entry,kept] of submitAccessCache)if(now-kept.at>=SUBMIT_ACCESS_MS)submitAccessCache.delete(entry);
  submitAccessCache.set(cacheKey,{at:now,access});
  return access;
}

export async function probeWorker(pool:Pool,catalogue:CapabilityBundle[],worker:{id:string;workspace_id:string;origin:string;api_prefix:string;kind?:string;inventory?:WorkerInventory}) {
  /* One slow or refused probe should not reject work: when the caller hands over the row it
     already read (the monitor selects *), a first failure keeps that inventory and the worker
     only reads offline once two probes in a row have failed. */
  const cloud=worker.kind==="cloud";
  const previous=worker.inventory as (ProbedCloudInventory&{probeFailures?:number})|undefined;
  const previousFailures=Number(previous?.probeFailures??0);
  const inventory:ProbedCloudInventory={online:false,nodes:[],models:[],credentials:[],objectInfoChecked:false,checkedModelFolders:[],inventoryIssues:[],...(cloud?{modelInventory:"cloud" as const}:{})};
  try {
    const response=await fetch(`${worker.origin}${worker.api_prefix}/object_info`,{signal:AbortSignal.timeout(15000),redirect:"error",...(cloud?{headers:cloudHeaders()}:{})});
    if(!response.ok)throw new Error("request_failed");const info:unknown=await response.json();
    if(!info||typeof info!=="object"||Array.isArray(info))throw new Error("invalid_response");
    inventory.nodes=Object.keys(info);inventory.objectInfoChecked=true;inventory.online=true;inventory.probeFailures=0;
    /* A Cloud worker has no /system_stats and no model folders: Comfy Cloud keeps its own models,
       so the probe asks for the node list only. /free is never called on Cloud. */
    if(!cloud){
      try{
        const stats=await fetch(`${worker.origin}${worker.api_prefix}/system_stats`,{signal:AbortSignal.timeout(10000),redirect:"error"});
        if(stats.ok){const body=await stats.text();if(body.length<=128*1024)inventory.hardware=parseWorkerHardware(JSON.parse(body),MIN_FREE_RAM_SHARE);}
      }catch{/* Missing hardware telemetry does not fabricate an incompatibility. */}
      const folders=[...new Set(catalogue.flatMap(b=>b.manifest.routes.flatMap(r=>r.requirements.filter(q=>q.kind==="model"&&q.location).map(q=>q.location!))))].sort();
      for(const folder of folders){
        try{
          const response=await fetch(`${worker.origin}${worker.api_prefix}/models/${encodeURIComponent(folder)}`,{signal:AbortSignal.timeout(15000),redirect:"error"});
          if(!response.ok)throw new Error("request_failed");const files:unknown=await response.json();
          if(!Array.isArray(files)||!files.every(f=>typeof f==="string"))throw new Error("invalid_response");
          inventory.checkedModelFolders!.push(folder);inventory.models.push(...files.map(file=>`${folder}/${file}`));
        }catch(error){inventory.inventoryIssues!.push({scope:"models",folder,code:error instanceof Error&&error.message==="invalid_response"?"invalid_response":"request_failed"});}
      }
    }else{
      /* Cloud keeps its own model files and has no folder endpoint, so the files its node list
         offers are the inventory. The probe's own view of the key's account is asked once per
         probe; an unknown answer keeps what the last probe found. */
      inventory.modelFiles=cloudModelFiles(info);
      const access=await probeSubmitAccess(worker);
      inventory.canSubmit=access.canSubmit??previous?.canSubmit;
      inventory.submitBlockedReason=access.canSubmit===undefined?previous?.submitBlockedReason:access.submitBlockedReason;
    }
  }catch(error){
    const failures=previousFailures+1,tolerate=previous?.online===true&&failures<2;
    inventory.online=tolerate;inventory.objectInfoChecked=tolerate?previous!.objectInfoChecked:false;
    inventory.nodes=tolerate?previous!.nodes:[];inventory.models=tolerate?previous!.models:[];
    inventory.checkedModelFolders=tolerate?previous!.checkedModelFolders:[];
    inventory.modelFiles=tolerate?previous!.modelFiles:undefined;
    inventory.hardware=tolerate?previous!.hardware:undefined;
    inventory.probeFailures=failures;
    inventory.inventoryIssues=[{scope:"object_info",code:error instanceof Error&&error.message==="invalid_response"?"invalid_response":"request_failed"}];
    // Whether the account may submit is about the key, not about a worker that just went quiet.
    if(cloud){inventory.canSubmit=previous?.canSubmit;inventory.submitBlockedReason=previous?.submitBlockedReason;}
  }
  /* Always persist the result. An earlier compare-and-set on checked_at looked safer, but it
     silently skipped whenever the value did not round-trip, which left checked_at stale — and
     the client treats a worker older than five minutes as offline. */
  await pool.query("UPDATE workers SET inventory=$1,checked_at=now() WHERE workspace_id=$2 AND id=$3",[JSON.stringify(inventory),worker.workspace_id,worker.id]);
  return inventory;
}
export class WorkerMonitor {
  private pending:Promise<void>|null=null;private stopped=false;
  constructor(private pool:Pool,private catalogue:CapabilityBundle[]){}
  tick(){if(this.stopped)return Promise.resolve();if(this.pending)return this.pending;this.pending=this.refresh().finally(()=>{this.pending=null;});return this.pending;}
  async close(){this.stopped=true;await this.pending;}
  private async refresh(){
    const workers=(await this.pool.query("SELECT * FROM workers WHERE enabled=true AND (checked_at IS NULL OR checked_at<now()-interval '1 minute')")).rows;
    for(const worker of workers)if(!this.stopped)await probeWorker(this.pool,this.catalogue,worker);
  }
}

// A tiny stand-in for Comfy Cloud, used only by tests. It serves the calls the app
// makes without a real key or credits: the node probe, the native prompt/queue/history
// path and the API v2 asset upload and job/download routes the official SDK uses.

import http from "node:http";
import type {AddressInfo} from "node:net";

/** The nodes of one simple pack (flux2-klein-t2i) plus a few core nodes. */
export const FAKE_FLUX2_NODES=[
  "UNETLoader","CLIPLoader","VAELoader","CLIPTextEncode","EmptyFlux2LatentImage",
  "Flux2Scheduler","KSamplerSelect","SamplerCustomAdvanced","CFGGuider","RandomNoise",
  "VAEDecode","SaveImage","PrimitiveInt","PrimitiveStringMultiline",
];
export const FAKE_CORE_NODES=["LoadImage","KSampler","CheckpointLoaderSimple","SaveVideo","CreateVideo","GetVideoComponents","ImageScale"];

/** The nodes the cloud character-swap packs need, as a probed Comfy Cloud reports them. */
export const FAKE_REPLACE_NODES=[
  "LoadVideo","KlingOmniProEditVideoNode","ByteDance2ReferenceNodeV2",
  "MiniMaxH3ReferenceToVideo","UNETLoader","CLIPLoader","VAELoader","VAEDecodeAudio","VAEDecode",
  "KSamplerSelect","RandomNoise","BasicGuider","BasicScheduler","SamplerCustomAdvanced",
];

/** One request the fake received, with the header values kept for assertions. */
export type FakeRequest={
  method:string;
  path:string;
  headers:http.IncomingHttpHeaders;
  body:string;
  /** The caller presented the expected key as a Bearer token or X-API-Key. */
  authorized:boolean;
};

export type FakeComfyCloud={
  url:string;
  requests:FakeRequest[];
  /** The filename the fake reports for its one saved image. */
  outputName:string;
  /** Inputs uploaded as Cloud assets, in the order the caller sent them. */
  inputs:Array<{id:string;contentType:string;filePath:string;bytes:number}>;
  /** How many jobs the fake has made. A refused submit makes none. */
  jobCount:()=>number;
  /** Finish the last job (or the named one) with one saved image. */
  succeed:(jobId?:string)=>string;
  lastGraph:()=>Record<string,unknown>|undefined;
  close:()=>Promise<void>;
};

type FakeOutput={node_id:string;name:string;type:string;content_type:string;size_bytes:number;id:string;hash:string|null;url:string;url_expires_at:string;job_id:string};
/** Like Comfy Cloud, the picture is reported on the graph's own SaveImage node ("9" when there is none). */
function saveNodeOf(graph:Record<string,unknown>):string{
  return Object.entries(graph).find(([,node])=>(node as {class_type?:string})?.class_type==="SaveImage")?.[0]??"9";
}
type FakeJob={id:string;saveNode:string;status:string;createdAt:string;completedAt:string|null;outputs:FakeOutput[];error:{code:string;message:string}|null};

type Options={
  key:string;
  image:Buffer;
  nodes?:string[];
  /** Answer the ComfyUI input upload route. Comfy Cloud has none (`/api/upload/image` is a 404
   *  there), so this stays off unless a test is about the older native upload path. */
  nativeUpload?:boolean;
  /** "free_tier" is an account that reads, uploads and probes fine and has every run refused with
   *  the cloud's own 403, exactly as the live service answered a free-tier key on 2026-10-27.
   *  "graph_refused" answers every prompt with a 400 about the graph, the way the live service
   *  answers a graph it will not validate: a complaint about the graph, not about the plan. */
  submitAccess?:"allowed"|"free_tier"|"graph_refused";
  /** The model files the fake offers in its own node lists, the way Comfy Cloud lists them:
   *  there is no model folder endpoint, so a loader's options are where its files show up. */
  modelFiles?:string[];
  /** The Comfy account behind the key, as api.comfy.org answers `/customers/me` and
   *  `/customers/balance` and the cloud app answers `/api/workspaces/current`. */
  account?:{name?:string;email?:string;cents?:number;workspace?:string};
};

const FREE_TIER_SENTENCE="API key authentication is not available for free tier accounts";

function presentedKey(request:http.IncomingMessage):string|undefined{
  const bearer=/^Bearer\s+(.+)$/i.exec(String(request.headers.authorization??"").trim())?.[1]?.trim();
  return bearer||(typeof request.headers["x-api-key"]==="string"?request.headers["x-api-key"].trim():undefined);
}

function sendJson(response:http.ServerResponse,status:number,body:unknown):void{
  const text=JSON.stringify(body);
  response.writeHead(status,{"Content-Type":"application/json","Content-Length":Buffer.byteLength(text)});
  response.end(text);
}

export async function startFakeComfyCloud(options:Options):Promise<FakeComfyCloud>{
  const nodes=[...new Set([...(options.nodes??[...FAKE_FLUX2_NODES,...FAKE_CORE_NODES])])];
  const objectInfo=Object.fromEntries(nodes.map(node=>[node,{input:{required:{} as Record<string,unknown>},input_order:{required:[]}}]));
  if(options.modelFiles?.length){
    // ComfyUI offers a loader's files as a widget with a fixed list, and that is the only place a
    // cloud's own files can be read: Cloud has no /models folder endpoint.
    const loader=objectInfo["UNETLoader"]??objectInfo[nodes[0]!]!;
    loader.input.required.unet_name=[[...options.modelFiles],{}];
  }
  const outputName="flux2-klein-t2i_00001_.png";
  const account={name:options.account?.name??"Fake Person",email:options.account?.email??"person@example.test",cents:options.account?.cents??1000,workspace:options.account?.workspace??"Personal Workspace"};
  const jobs=new Map<string,FakeJob>();
  const assets=new Map<string,Buffer>();
  const inputs:Array<{id:string;contentType:string;filePath:string;bytes:number}>=[];
  const history=new Map<string,unknown>();
  const requests:FakeRequest[]=[];
  let jobCounter=0,promptCounter=0,lastGraph:Record<string,unknown>|undefined;

  const authorized=(request:http.IncomingMessage)=>presentedKey(request)===options.key;

  const jobJson=(job:FakeJob)=>({
    id:job.id,
    status:job.status,
    created_at:job.createdAt,
    started_at:job.status==="queued"?null:job.createdAt,
    completed_at:job.completedAt,
    expires_at:new Date(Date.parse(job.createdAt)+24*60*60*1000).toISOString(),
    queue_position:null,
    progress:null,
    outputs:job.outputs,
    error:job.error,
    urls:{self:`/api/v2/jobs/${job.id}`,events:`/api/v2/jobs/${job.id}/events`,cancel:`/api/v2/jobs/${job.id}/cancel`},
  });

  const server=http.createServer(async(request,response)=>{
    const chunks:Buffer[]=[];
    for await(const chunk of request)chunks.push(chunk as Buffer);
    const raw=Buffer.concat(chunks),body=raw.toString("utf8");
    const url=new URL(request.url??"/","http://fake");
    const path=url.pathname;
    requests.push({method:request.method??"",path,headers:{...request.headers},body,authorized:authorized(request)});
    try{
      /* Comfy Cloud has no /system_stats and no model folders. */
      if(path==="/api/system_stats"||path.startsWith("/api/models/")){response.writeHead(404);response.end();return;}
      if(["/api/object_info","/api/prompt","/api/upload/image"].includes(path)||path.startsWith("/api/v2/")||path==="/api/queue"||path.startsWith("/api/history")){
        if(!authorized(request)){sendJson(response,401,{error:"unauthorized"});return;}
      }
      /* The account reads: api.comfy.org's `/customers/*` and the cloud app's workspace, the
         calls the ComfyUI frontend makes with a stored API key. One port serves both here. */
      if(path.startsWith("/customers/")||path==="/api/workspaces/current"){
        if(!authorized(request)){sendJson(response,401,{error:"unauthorized"});return;}
      }
      if(request.method==="GET"&&path==="/customers/me"){
        sendJson(response,200,{email:account.email,id:"fake-customer",is_admin:false,name:account.name});return;
      }
      if(request.method==="GET"&&path==="/customers/balance"){
        // Comfy's own naming: the `*_micros` fields carry cents.
        sendJson(response,200,{amount_cents:account.cents,amount_micros:account.cents,cloud_credit_balance_cents:0,cloud_credit_balance_micros:0,currency:"usd",effective_balance_cents:account.cents,effective_balance_micros:account.cents,prepaid_balance_cents:account.cents,prepaid_balance_micros:account.cents});return;
      }
      if(request.method==="GET"&&path==="/api/workspaces/current"){
        sendJson(response,200,{auth_method:"cloud_api_key",id:"fake-workspace",name:account.workspace,permissions:["owner:*"],role:"owner",type:"personal"});return;
      }
      if(request.method==="GET"&&path==="/api/object_info"){sendJson(response,200,objectInfo);return;}
      if(request.method==="POST"&&path==="/api/prompt"){
        // The native submit is refused too on a free-tier account, with its own error type, and
        // the plan is checked before the graph there.
        if(options.submitAccess==="free_tier"){sendJson(response,403,{error:{message:FREE_TIER_SENTENCE,type:"FREE_TIER_NOT_ALLOWED"}});return;}
        const parsed=JSON.parse(body) as {prompt?:Record<string,unknown>};
        // An empty prompt is a graph error and never reaches the plan check, as the live service
        // answered it on 2026-10-27, so a 400 here proves nothing about the plan.
        if(!parsed.prompt||!Object.keys(parsed.prompt).length){sendJson(response,400,{error:{message:"Prompt has no outputs",type:"VALIDATION_ERROR"}});return;}
        if(options.submitAccess==="graph_refused"){sendJson(response,400,{error:{message:"Prompt has no outputs",type:"VALIDATION_ERROR"}});return;}
        lastGraph=parsed.prompt;
        const promptId=`fake-prompt-${++promptCounter}`;
        history.set(promptId,{prompt:lastGraph,outputs:{[saveNodeOf(parsed.prompt)]:{images:[{filename:outputName,subfolder:"",type:"output"}]}},status:{completed:true,status_str:"success",messages:[]}});
        sendJson(response,200,{prompt_id:promptId,number:promptCounter,node_errors:{}});return;
      }
      if(request.method==="POST"&&path==="/api/upload/image"){
        // Comfy Cloud has no ComfyUI input folder; only a test about the older native
        // upload path turns this on.
        if(!options.nativeUpload){sendJson(response,404,{error:{message:"Not Found",type:"not_found"}});return;}
        // ComfyUI reports the name it stored, which is the name the graph then loads.
        const name=/filename="([^"]+)"/.exec(body)?.[1]??"upload.png";
        sendJson(response,200,{name,subfolder:"",type:"input"});return;
      }
      if(request.method==="POST"&&path==="/api/v2/assets"){
        // An input goes up as a Cloud asset; the graph then names it with a core/ASSET reference.
        const field=(name:string)=>new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]+)`).exec(body)?.[1];
        const id=`fake-input-${inputs.length+1}`;
        const entry={id,contentType:field("content_type")??"application/octet-stream",filePath:field("file_path")??"upload.bin",bytes:raw.length};
        inputs.push(entry);
        sendJson(response,201,{id,hash:null,size_bytes:entry.bytes,content_type:entry.contentType,file_path:entry.filePath,created_new:true,created_at:new Date().toISOString(),url:`/api/v2/assets/${id}/content`,url_expires_at:new Date(Date.now()+60*60*1000).toISOString()});return;
      }
      if(request.method==="HEAD"&&path.startsWith("/api/v2/assets/by-hash/")){
        // These bytes are new to the fake, so the SDK uploads them.
        response.writeHead(404);response.end();return;
      }
      if(request.method==="GET"&&path==="/api/queue"){sendJson(response,200,{queue_running:[],queue_pending:[]});return;}
      if(request.method==="GET"&&path==="/api/history"){sendJson(response,200,Object.fromEntries(history));return;}
      if(request.method==="GET"&&path.startsWith("/api/history/")){
        const id=decodeURIComponent(path.slice("/api/history/".length));
        sendJson(response,200,history.has(id)?{[id]:history.get(id)}:{});return;
      }
      if(request.method==="GET"&&path==="/api/view"){
        response.writeHead(200,{"Content-Type":"image/png","Content-Length":options.image.length});response.end(options.image);return;
      }
      if(request.method==="POST"&&path==="/api/v2/jobs"){
        // A free-tier account may read, upload and probe, and every submit is refused.
        if(options.submitAccess==="free_tier"){sendJson(response,403,{error:{code:"forbidden",message:FREE_TIER_SENTENCE}});return;}
        const parsed=JSON.parse(body) as {workflow?:Record<string,unknown>};
        // An empty graph is refused before any job exists, for an account that may submit: this is
        // the answer the app reads as "this key may submit a run".
        if(!parsed.workflow||!Object.keys(parsed.workflow).length){sendJson(response,400,{error:{code:"invalid_request",message:"workflow has no nodes"}});return;}
        lastGraph=parsed.workflow;
        const job:FakeJob={id:`fake-job-${++jobCounter}`,saveNode:saveNodeOf(parsed.workflow),status:"queued",createdAt:new Date().toISOString(),completedAt:null,outputs:[],error:null};
        jobs.set(job.id,job);
        sendJson(response,201,jobJson(job));return;
      }
      if(request.method==="GET"&&path.startsWith("/api/v2/jobs/")){
        const id=decodeURIComponent(path.slice("/api/v2/jobs/".length).split("/")[0]!);
        const job=jobs.get(id);
        if(!job){sendJson(response,404,{error:"not_found"});return;}
        // The first poll reports a job that started running; the test finishes it.
        if(job.status==="queued")job.status="running";
        sendJson(response,200,jobJson(job));return;
      }
      if(request.method==="GET"&&path.startsWith("/api/v2/assets/")&&path.endsWith("/content")){
        const id=decodeURIComponent(path.slice("/api/v2/assets/".length,-"/content".length));
        const bytes=assets.get(id);
        if(!bytes){sendJson(response,404,{error:"not_found"});return;}
        response.writeHead(200,{"Content-Type":"image/png","Content-Length":bytes.length});response.end(bytes);return;
      }
      response.writeHead(404);response.end("not found");
    }catch(error){
      sendJson(response,500,{error:error instanceof Error?error.message:"fake failed"});
    }
  });

  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const {port}=server.address() as AddressInfo;

  return{
    url:`http://127.0.0.1:${port}`,
    requests,
    outputName,
    inputs,
    jobCount:()=>jobs.size,
    succeed(jobId?:string){
      const job=jobId?jobs.get(jobId):[...jobs.values()].at(-1);
      if(!job)throw new Error("The fake has no job to finish");
      const assetId=`fake-asset-${job.id}`;
      assets.set(assetId,options.image);
      job.outputs=[{node_id:job.saveNode,name:outputName,type:"image",content_type:"image/png",size_bytes:options.image.length,id:assetId,hash:null,url:`/api/v2/assets/${assetId}/content`,url_expires_at:new Date(Date.now()+60*60*1000).toISOString(),job_id:job.id}];
      job.status="succeeded";job.completedAt=new Date().toISOString();
      return job.id;
    },
    lastGraph:()=>lastGraph,
    close:()=>new Promise<void>(resolve=>server.close(()=>resolve())),
  };
}

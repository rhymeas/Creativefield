import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import type {CapabilityBundle} from "../src/capabilities/types";
import {capabilityReadiness} from "../src/capabilities/readiness";
import {member,HttpError} from "./auth";
import {transaction} from "./db";
import {hashToken,newId} from "./crypto";
import type {DiskStore} from "./storage";
import {canonical,prepareInvocation,scalarControls,type PreparedRun} from "./run-submission";
import {inspectVideoSource,videoExtensionReadiness,VideoExtensionMediaError,VideoExtensionToolUnavailableError} from "./video-extension-media";
import {planVideoExtension,videoExtensionIntentSchema} from "./video-extension-plan";
import {prepareVideoSource} from "./video-extension-prepare";
import {VideoExtensionService} from "./video-extension-execution";

const base="/api/v1/workspaces/:workspaceId",ws=z.object({workspaceId:z.uuid()}),item=ws.extend({id:z.uuid()});
const planRequest=videoExtensionIntentSchema.omit({contractVersion:true}).strict();
const prepareRequest=z.object({projectId:z.uuid(),assetId:z.uuid(),clean:z.boolean().optional(),fps:z.number().int().min(8).max(60).optional()}).strict();
const createRequest=planRequest.extend({workerId:z.uuid().optional(),idempotencyKey:z.string().min(8).max(128),controls:scalarControls.default({})}).strict();
const columns="id,project_id,source_asset_id,worker_id,created_by,plan,state,error,output_asset_id,created_at,updated_at";

async function sourcePlan(pool:Pool,store:DiskStore,workspaceId:string,body:z.infer<typeof planRequest>){
  const source=(await pool.query("SELECT id,project_id,storage_key,sha256,bytes,media_type FROM assets WHERE workspace_id=$1 AND id=$2 AND project_id=$3",[workspaceId,body.sourceAssetId,body.projectId])).rows[0];
  if(!source||source.media_type!=="video")throw new HttpError(404,"Project video source not found");
  try{
    const envelope=await inspectVideoSource(await store.file(workspaceId,source.storage_key),{sourceAssetId:source.id,projectId:source.project_id});
    if(envelope.sha256!==source.sha256||envelope.bytes!==Number(source.bytes))throw new Error("stored metadata mismatch");
    return planVideoExtension({contractVersion:1,projectId:body.projectId,sourceAssetId:body.sourceAssetId,startFrame:body.startFrame,endFrameExclusive:body.endFrameExclusive,extensionFrames:body.extensionFrames,overlapFrames:body.overlapFrames,audioPolicy:body.audioPolicy},envelope);
  }catch(error){if(error instanceof HttpError)throw error;if(error instanceof VideoExtensionToolUnavailableError)throw new HttpError(422,error.message);if(error instanceof VideoExtensionMediaError)throw new HttpError(422,error.message);throw new HttpError(422,"Source video is missing, changed or outside the supported frame contract");}
}

export async function videoExtensionRoutes(app:FastifyInstance,pool:Pool,store:DiskStore,catalogue:CapabilityBundle[]){
  const service=new VideoExtensionService(pool,store),workflow=()=>catalogue.find(bundle=>bundle.manifest.id==="video-edit");
  app.get(`${base}/video-extension-requirements`,async request=>{
    const {workspaceId}=ws.parse(request.params);await member(pool,request,workspaceId);const query=z.object({workerId:z.uuid().optional()}).strict().parse(request.query),tools=await videoExtensionReadiness(),bundle=workflow();let local:any={state:"unsupported",reasons:["The local VACE continuation workflow is unavailable."],missing:bundle?.manifest.routes[0]?.requirements??[]};
    if(bundle&&query.workerId){const worker=(await pool.query("SELECT inventory,checked_at FROM workers WHERE workspace_id=$1 AND id=$2 AND enabled=true",[workspaceId,query.workerId])).rows[0];if(worker){const inventory=structuredClone(worker.inventory??{online:false,nodes:[],models:[],credentials:[]});if(!worker.checked_at||Date.now()-new Date(worker.checked_at).getTime()>5*60*1000)inventory.online=false;local=capabilityReadiness(bundle.manifest,"local",inventory);}}
    return {contractVersion:1,trim:tools,forwardExtension:{workflow:local,tools},audioPolicies:["mute","preserve"],limits:{fps:{numerator:16,denominator:1},trimFps:{min:8,max:60},direction:"forward_only",maximumGenerationFrames:81}};
  });
  app.post(`${base}/video-extension-plans`,async request=>{const {workspaceId}=ws.parse(request.params);await member(pool,request,workspaceId,"creator");const body=planRequest.parse(request.body);return sourcePlan(pool,store,workspaceId,body);});
  app.post(`${base}/video-sources/prepare`,async(request,reply)=>{
    const {workspaceId}=ws.parse(request.params),user=await member(pool,request,workspaceId,"creator"),body=prepareRequest.parse(request.body),cancel=new AbortController();
    reply.raw.on("close",()=>{if(!reply.raw.writableEnded)cancel.abort();});
    return prepareVideoSource(pool,store,workspaceId,user.id,body,cancel.signal);
  });
  app.post(`${base}/video-extensions`,async request=>{
    const {workspaceId}=ws.parse(request.params),user=await member(pool,request,workspaceId,"creator"),body=createRequest.parse(request.body),requestHash=hashToken(canonical(body));
    const existing=(await pool.query(`SELECT ${columns},request_hash FROM video_extension_jobs WHERE workspace_id=$1 AND idempotency_key=$2`,[workspaceId,body.idempotencyKey])).rows[0];
    if(existing){if(existing.request_hash!==requestHash)throw new HttpError(409,"Idempotency key was already used for another video-extension request");delete existing.request_hash;return existing;}
    const tools=await videoExtensionReadiness();if(tools.state!=="ready")throw new HttpError(422,`Video editing installation required: ${tools.missing.join(", ")}. ${tools.instructions}`);
    const plan=await sourcePlan(pool,store,workspaceId,body),bundle=workflow();let prepared:PreparedRun|undefined;
    if(plan.operation==="forward_extend"){
      if(!body.workerId)throw new HttpError(400,"Choose a local worker for forward extension");
      const route=bundle?.manifest.routes.find(candidate=>candidate.id==="local");
      if(!bundle||route?.implementation!=="implemented")throw new HttpError(422,"Forward extension remains experimental and unavailable until a reviewed VACE continuation graph is locally qualified");
      if(["generation_frames","overlap_frames","context_start_frame"].some(key=>key in body.controls))throw new HttpError(400,"Continuation context controls are server-owned; use the planned trim and overlap fields.");
      prepared=await transaction(pool,client=>prepareInvocation(client,catalogue,workspaceId,{projectId:body.projectId,workerId:body.workerId!,idempotencyKey:body.idempotencyKey,capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_video:body.sourceAssetId},controls:{...body.controls,generation_frames:plan.continuation!.generationFrames,overlap_frames:plan.continuation!.overlapFrames,context_start_frame:plan.continuation!.contextStartFrame},audioPolicy:"mute"},store,{videoContinuationPlan:plan}));
    }else if(body.workerId||Object.keys(body.controls).length)throw new HttpError(400,"Trim-only requests do not accept a worker or generation controls");
    return transaction(pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`video-extension-request:${workspaceId}/${body.idempotencyKey}`]);
      const old=(await client.query(`SELECT ${columns},request_hash FROM video_extension_jobs WHERE workspace_id=$1 AND idempotency_key=$2`,[workspaceId,body.idempotencyKey])).rows[0];if(old){if(old.request_hash!==requestHash)throw new HttpError(409,"Idempotency key was already used for another video-extension request");delete old.request_hash;return old;}
      if(!(await client.query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2",[workspaceId,body.projectId])).rowCount)throw new HttpError(404,"Project not found");
      const id=newId(),job=(await client.query(`INSERT INTO video_extension_jobs(id,workspace_id,project_id,source_asset_id,worker_id,created_by,idempotency_key,request_hash,plan,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING ${columns}`,[id,workspaceId,body.projectId,body.sourceAssetId,body.workerId??null,user.id,body.idempotencyKey,requestHash,JSON.stringify(plan)])).rows[0];
      let ordinal=0;if(prepared)await client.query("INSERT INTO video_extension_stages(workspace_id,job_id,ordinal,kind,state,prepared,input_asset_id) VALUES($1,$2,$3,'generate','pending',$4,$5)",[workspaceId,id,ordinal++,JSON.stringify(prepared),body.sourceAssetId]);
      await client.query("INSERT INTO video_extension_stages(workspace_id,job_id,ordinal,kind,state,input_asset_id) VALUES($1,$2,$3,'stitch','pending',$4)",[workspaceId,id,ordinal,body.sourceAssetId]);
      await client.query("INSERT INTO video_extension_events(workspace_id,job_id,state,detail) VALUES($1,$2,'pending',$3)",[workspaceId,id,JSON.stringify({planDigest:plan.planDigest,operation:plan.operation})]);return job;
    });
  });
  app.get(`${base}/video-extensions/:id`,async request=>{const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId);const job=(await pool.query(`SELECT ${columns} FROM video_extension_jobs WHERE workspace_id=$1 AND id=$2`,[workspaceId,id])).rows[0];if(!job)throw new HttpError(404,"Video extension job not found");const stages=(await pool.query("SELECT ordinal,kind,state,child_run_id,input_asset_id,output_asset_id,detail FROM video_extension_stages WHERE workspace_id=$1 AND job_id=$2 ORDER BY ordinal",[workspaceId,id])).rows;return {...job,stages};});
  app.get(`${base}/video-extensions`,async request=>{
    const {workspaceId}=ws.parse(request.params),user=await member(pool,request,workspaceId);
    const {projectId,requestKey}=z.object({projectId:z.uuid(),requestKey:z.string().min(8).max(128).optional()}).strict().parse(request.query);
    return requestKey?(await pool.query(`SELECT ${columns} FROM video_extension_jobs WHERE workspace_id=$1 AND project_id=$2 AND created_by=$3 AND idempotency_key=$4`,[workspaceId,projectId,user.id,requestKey])).rows
      :(await pool.query(`SELECT ${columns} FROM video_extension_jobs WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 50`,[workspaceId,projectId])).rows;
  });
  app.get(`${base}/video-extensions/:id/events`,async request=>{const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId);const {after}=z.object({after:z.coerce.number().int().min(0).default(0)}).parse(request.query);return (await pool.query("SELECT seq,state,detail,created_at FROM video_extension_events WHERE workspace_id=$1 AND job_id=$2 AND seq>$3 ORDER BY seq LIMIT 200",[workspaceId,id,after])).rows;});
  for(const operation of ["cancel","retry-stitch"] as const)app.post(`${base}/video-extensions/:id/${operation}`,async request=>{
    const {workspaceId,id}=item.parse(request.params),user=await member(pool,request,workspaceId,"creator");const result=await transaction(pool,async client=>{const job=(await client.query("SELECT * FROM video_extension_jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,id])).rows[0];if(!job)throw new HttpError(404,"Video extension job not found");if(user.role!=="admin"&&job.created_by!==user.id)throw new HttpError(403,"Only the job owner or an administrator may change execution");
      if(operation==="retry-stitch"){if(job.state!=="stitch_failed")throw new HttpError(409,"Only failed stitching can be retried without regeneration");await client.query("UPDATE video_extension_stages SET state='pending' WHERE workspace_id=$1 AND job_id=$2 AND kind='stitch'",[workspaceId,id]);await client.query("UPDATE video_extension_jobs SET state='pending',error=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",[workspaceId,id]);await client.query("INSERT INTO video_extension_events(workspace_id,job_id,state) VALUES($1,$2,'pending')",[workspaceId,id]);return {state:"pending"};}
      if(["pending","generating","stitching","stitch_failed"].includes(job.state)){await client.query("UPDATE video_extension_jobs SET state='cancel_requested',error=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",[workspaceId,id]);await client.query("INSERT INTO video_extension_events(workspace_id,job_id,state) VALUES($1,$2,'cancel_requested')",[workspaceId,id]);return {state:"cancel_requested"};}return {state:job.state};});if(operation==="cancel")service.interrupt(id);return result;
  });
  return service;
}


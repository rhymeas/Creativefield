import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import type {CapabilityBundle} from "../src/capabilities/types";
import {capabilityReadiness} from "../src/capabilities/readiness";
import {member,HttpError} from "./auth";
import {transaction} from "./db";
import {hashToken} from "./crypto";
import {canonical,cancelRun} from "./run-submission";
import {fileSha256} from "./masked-media";
import {sanitizedPosePreview} from "./pose-preview-admission";
import {PosePreviewService} from "./pose-preview-service";
import type {DiskStore} from "./storage";

const base="/api/v1/workspaces/:workspaceId",ws=z.object({workspaceId:z.uuid()}),item=ws.extend({id:z.uuid()});
const create=z.object({requestId:z.uuid(),projectId:z.uuid(),sourceAssetId:z.uuid(),workerId:z.uuid()}).strict();
const columns="id,project_id,source_asset_id,source_sha256,worker_id,created_by,state,run_id,error,created_at,updated_at";
export async function posePreviewRoutes(app:FastifyInstance,pool:Pool,store:DiskStore,catalogue:CapabilityBundle[]){
  const service=new PosePreviewService(pool,store,catalogue);app.addHook("onClose",()=>service.close());
  app.get(`${base}/pose-preview-requirements`,async request=>{
    const {workspaceId}=ws.parse(request.params);await member(pool,request,workspaceId);
    const {workerId}=z.object({workerId:z.uuid()}).strict().parse(request.query),bundle=catalogue.find(entry=>entry.manifest.id==="sdpose-preview-1");
    const worker=(await pool.query("SELECT inventory,checked_at FROM workers WHERE workspace_id=$1 AND id=$2 AND enabled=true",[workspaceId,workerId])).rows[0];
    if(!bundle||!worker)return {state:"unsupported",reasons:["Pose detection is not available on this worker."],missing:[]};
    const inventory=structuredClone(worker.inventory??{online:false,nodes:[],models:[],credentials:[]});
    if(!worker.checked_at||Date.now()-new Date(worker.checked_at).getTime()>300000)inventory.online=false;
    return capabilityReadiness(bundle.manifest,"local",inventory);
  });
  app.post(`${base}/pose-previews`,async request=>{
    const {workspaceId}=ws.parse(request.params),user=await member(pool,request,workspaceId,"creator"),body=create.parse(request.body),digest=hashToken(canonical(body));
    return transaction(pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`pose-preview-create:${body.requestId}`]);
      const old=(await client.query(`SELECT ${columns},request_hash FROM pose_previews WHERE id=$1`,[body.requestId])).rows[0];
      if(old){
        const scoped=(await client.query("SELECT id FROM pose_previews WHERE workspace_id=$1 AND id=$2",[workspaceId,body.requestId])).rowCount;
        if(!scoped||old.request_hash!==digest||old.created_by!==user.id)throw new HttpError(409,"This preview request has already been used.");
        delete old.request_hash;return old;
      }
      const source=(await client.query("SELECT storage_key,sha256 FROM assets WHERE workspace_id=$1 AND id=$2 AND project_id=$3 AND media_type='video'",[workspaceId,body.sourceAssetId,body.projectId])).rows[0];
      if(!source)throw new HttpError(404,"Choose a video saved in this project.");
      if(await fileSha256(await store.file(workspaceId,source.storage_key))!==source.sha256)throw new HttpError(422,"The driving clip changed. Upload it again.");
      const worker=(await client.query("SELECT inventory,checked_at FROM workers WHERE workspace_id=$1 AND id=$2 AND enabled=true",[workspaceId,body.workerId])).rows[0],bundle=catalogue.find(entry=>entry.manifest.id==="sdpose-preview-1");
      if(!worker||!bundle)throw new HttpError(422,"Choose a local worker with the pose workflow installed.");
      const inventory=structuredClone(worker.inventory??{online:false,nodes:[],models:[],credentials:[]});
      if(!worker.checked_at||Date.now()-new Date(worker.checked_at).getTime()>300000)inventory.online=false;
      const readiness=capabilityReadiness(bundle.manifest,"local",inventory);
      if(readiness.state!=="ready")throw new HttpError(422,readiness.reasons[0]??"The pose workflow is not ready on this worker.");
      return(await client.query(`INSERT INTO pose_previews(id,workspace_id,project_id,source_asset_id,source_sha256,worker_id,created_by,request_hash,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING ${columns}`,[body.requestId,workspaceId,body.projectId,body.sourceAssetId,source.sha256,body.workerId,user.id,digest])).rows[0];
    });
  });
  app.get(`${base}/pose-previews/:id`,async request=>{
    const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId);
    const job=(await pool.query(`SELECT ${columns} FROM pose_previews WHERE workspace_id=$1 AND id=$2`,[workspaceId,id])).rows[0];
    if(!job)throw new HttpError(404,"Pose preview not found.");
    const run=job.run_id?(await pool.query("SELECT state,output_ids FROM runs WHERE workspace_id=$1 AND id=$2",[workspaceId,job.run_id])).rows[0]:null;
    if(run&&["succeeded","failed","canceled"].includes(run.state))job.state=run.state;
    if(job.state!=="succeeded")return {...job,run_state:run?.state??null,frames:[]};
    const source=(await pool.query("SELECT storage_key,sha256 FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=$3",[workspaceId,job.project_id,job.source_asset_id])).rows[0];
    if(!source||source.sha256!==job.source_sha256||await fileSha256(await store.file(workspaceId,source.storage_key))!==job.source_sha256)throw new HttpError(422,"This pose preview belongs to an older version of the clip.");
    const assets=(await pool.query("SELECT id,metadata FROM assets WHERE workspace_id=$1 AND id=ANY($2::uuid[])",[workspaceId,run?.output_ids??[]])).rows;
    const frames=assets.map(asset=>({assetId:asset.id,...sanitizedPosePreview(asset.metadata?.posePreview)})).sort((a,b)=>(a.frameIndex??0)-(b.frameIndex??0));
    const expected=(await pool.query("SELECT count(*)::int AS n FROM pose_preview_frames WHERE workspace_id=$1 AND preview_id=$2",[workspaceId,id])).rows[0].n;
    if(!expected||frames.length!==expected||frames.some(frame=>frame.previewId!==id||frame.sourceAssetId!==job.source_asset_id||frame.sourceSha256!==job.source_sha256))throw new HttpError(422,"The saved pose preview is incomplete. Start a new preview.");
    return {...job,run_state:run.state,frames};
  });
  app.post(`${base}/pose-previews/:id/cancel`,async request=>{
    const {workspaceId,id}=item.parse(request.params),user=await member(pool,request,workspaceId,"creator");
    const result=await transaction(pool,async client=>{
      const job=(await client.query("SELECT state,created_by,run_id FROM pose_previews WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,id])).rows[0];
      if(!job)throw new HttpError(404,"Pose preview not found.");
      if(job.created_by!==user.id&&user.role!=="admin")throw new HttpError(403,"Only the owner or an administrator may cancel this preview.");
      if(["succeeded","failed","canceled"].includes(job.state))return {state:job.state};
      if(job.run_id)await cancelRun(client,workspaceId,job.run_id);
      await client.query("UPDATE pose_previews SET state='cancel_requested',updated_at=now() WHERE workspace_id=$1 AND id=$2",[workspaceId,id]);return {state:"cancel_requested"};
    });service.interrupt(id);return result;
  });
  return service;
}

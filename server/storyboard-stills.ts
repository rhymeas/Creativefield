import type {FastifyInstance} from "fastify";
import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import type {CapabilityBundle} from "../src/capabilities/types";
import {member,HttpError} from "./auth";
import {transaction} from "./db";
import {hashToken,newId} from "./crypto";
import {canonical,prepareInvocation,enqueuePreparedRun,scalarControls} from "./run-submission";

const base="/api/v1/workspaces/:workspaceId",item=z.object({workspaceId:z.uuid(),id:z.uuid()});
const columns="t.id,t.plan_key,t.source_revision,t.ordinal,t.prompt,t.child_run_id,t.approved_asset_id,t.approved_at,t.rejected_at,t.created_at,r.state,r.error,r.output_ids,r.scene,r.shot,r.take";

/** Approval is bound to a stable shot identity, exact prompt and the producing run. */
export async function approvedStoryboardStill(client:PoolClient,workspaceId:string,board:any,shot:any,takeId:string){
  const take=(await client.query(`SELECT t.*,r.state,r.output_ids,a.project_id,a.media_type FROM storyboard_still_takes t JOIN runs r ON r.workspace_id=t.workspace_id AND r.id=t.child_run_id LEFT JOIN assets a ON a.workspace_id=t.workspace_id AND a.id=t.approved_asset_id WHERE t.workspace_id=$1 AND t.storyboard_id=$2 AND t.id=$3`,[workspaceId,board.id,takeId])).rows[0];
  if(!take||take.plan_key!==shot.plan_key||take.prompt!==shot.prompt||!take.approved_at||take.state!=="succeeded"||take.media_type!=="image"||take.project_id!==board.project_id||take.output_ids?.length!==1||take.output_ids[0]!==take.approved_asset_id)throw new HttpError(422,`Shot ${shot.ordinal+1} needs a current approved still`);
  return take;
}

/** Stills use the existing durable run queue; no second execution service. */
export async function storyboardStillRoutes(app:FastifyInstance,pool:Pool,catalogue:CapabilityBundle[]){
  app.post(`${base}/storyboards/:id/stills`,async request=>{
    const {workspaceId,id}=item.parse(request.params),user=await member(pool,request,workspaceId,"creator");
    const body=z.object({revision:z.number().int().positive(),workerId:z.uuid(),idempotencyKey:z.string().min(8).max(128),capabilityId:z.string().max(120),version:z.string().max(40),controls:scalarControls,planKeys:z.array(z.uuid()).min(1).max(32).refine(keys=>new Set(keys).size===keys.length,"Duplicate shot selection").optional()}).strict().parse(request.body);
    const hash=hashToken(canonical({storyboardId:id,...body}));
    return transaction(pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`storyboard-still-request:${workspaceId}/${body.idempotencyKey}`]);
      const old=(await client.query("SELECT id,child_run_id,request_hash FROM storyboard_still_takes WHERE workspace_id=$1 AND batch_key=$2 ORDER BY ordinal",[workspaceId,body.idempotencyKey])).rows;
      if(old.length){if(old.some(t=>t.request_hash!==hash))throw new HttpError(409,"This still request identifier belongs to different content");return old.map(({request_hash,...take})=>take);}
      const board=(await client.query("SELECT * FROM storyboards WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,id])).rows[0];
      if(!board)throw new HttpError(404,"Storyboard not found");
      if(board.revision!==body.revision)throw new HttpError(409,"Storyboard changed; save and reload before generating stills");
      const bundle=catalogue.find(b=>b.manifest.id===body.capabilityId);
      if(!bundle)throw new HttpError(422,"Choose a local text-to-image or single-image edit workflow for stills");
      /* A still workflow may take one required image: it then edits the shot's cast picture into the frame. */
      const requiredInputs=(bundle.manifest.inputs??[]).filter(p=>p.required),imagePort=requiredInputs.length===1&&requiredInputs[0].type==="image"?requiredInputs[0].id:undefined;
      if(bundle.manifest.category!=="image"||requiredInputs.length>1||(requiredInputs.length===1&&!imagePort)||bundle.manifest.imageArtifacts||bundle.manifest.outputContract||!bundle.manifest.outputs.some(p=>p.type==="image"))throw new HttpError(422,"Choose a local text-to-image or single-image edit workflow for stills");
      if(body.controls.batch_size!==undefined&&body.controls.batch_size!==1)throw new HttpError(422,"Each shot still requires a single-image batch");
      if("prompt" in body.controls)throw new HttpError(400,"The saved shot supplies the still prompt");
      const allShots=(await client.query("SELECT * FROM shots WHERE workspace_id=$1 AND storyboard_id=$2 ORDER BY ordinal",[workspaceId,id])).rows;
      const shots=body.planKeys?allShots.filter(s=>body.planKeys!.includes(s.plan_key)):allShots;
      if(body.planKeys&&shots.length!==body.planKeys.length)throw new HttpError(422,"Selected shots no longer exist in this saved plan");
      if(!shots.length||shots.length>32||shots.some(s=>!s.prompt.trim()))throw new HttpError(422,"Save 1–32 shots with explicit prompts");
      const result=[];
      for(const shot of shots){
        const key=`storyboard-still:${body.idempotencyKey}:${shot.plan_key}`;
        const stillInputs:Record<string,string>={};
        if(imagePort){
          const startId=shot.settings?.elementInputs?.start_image?.assetId;
          if(!startId)throw new HttpError(422,`Shot ${shot.ordinal+1} has no character reference; choose a text-to-image still workflow or attach a cast picture`);
          if(!(await client.query("SELECT id FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND media_type='image'",[workspaceId,board.project_id,startId])).rowCount)throw new HttpError(422,`Shot ${shot.ordinal+1}: the character picture is missing from this project`);
          stillInputs[imagePort]=startId;
        }
        const prepared=await prepareInvocation(client,catalogue,workspaceId,{projectId:board.project_id,workerId:body.workerId,idempotencyKey:key,capabilityId:body.capabilityId,version:body.version,routeId:"local",inputs:stillInputs,controls:{...body.controls,prompt:shot.prompt},audioPolicy:"mute"});
        const run=await enqueuePreparedRun(client,workspaceId,user.id,prepared,key,hashToken(canonical(prepared)),{scene:1,shot:shot.ordinal+1});
        const takeId=newId();
        await client.query("INSERT INTO storyboard_still_takes(id,workspace_id,storyboard_id,plan_key,source_revision,ordinal,prompt,snapshot,child_run_id,batch_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[takeId,workspaceId,id,shot.plan_key,body.revision,shot.ordinal,shot.prompt,JSON.stringify({shot,invocation:prepared.invocation}),run.id,body.idempotencyKey,hash]);
        result.push({id:takeId,child_run_id:run.id});
      }
      return result;
    });
  });
  app.get(`${base}/storyboards/:id/stills`,async request=>{
    const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId);
    if(!(await pool.query("SELECT id FROM storyboards WHERE workspace_id=$1 AND id=$2",[workspaceId,id])).rowCount)throw new HttpError(404,"Storyboard not found");
    // Keep the latest approval even after many subsequent unapproved takes.
    return (await pool.query(`WITH current AS (SELECT t.*,row_number() OVER(PARTITION BY t.plan_key ORDER BY t.created_at DESC,t.id DESC) AS recent,row_number() OVER(PARTITION BY t.plan_key ORDER BY t.approved_at DESC NULLS LAST,t.id DESC) AS approval FROM storyboard_still_takes t JOIN shots s ON s.workspace_id=t.workspace_id AND s.storyboard_id=t.storyboard_id AND s.plan_key=t.plan_key AND s.prompt=t.prompt WHERE t.workspace_id=$1 AND t.storyboard_id=$2) SELECT ${columns} FROM current t JOIN runs r ON r.workspace_id=t.workspace_id AND r.id=t.child_run_id WHERE t.recent<=8 OR(t.approval=1 AND t.approved_at IS NOT NULL) ORDER BY t.created_at DESC,t.id DESC`,[workspaceId,id])).rows;
  });
  app.post(`${base}/storyboards/:id/stills/:takeId/approve`,async request=>{
    const {workspaceId,id,takeId}=item.extend({takeId:z.uuid()}).parse(request.params),user=await member(pool,request,workspaceId,"creator");
    z.object({}).strict().parse(request.body??{});
    return transaction(pool,async client=>{
      const board=(await client.query("SELECT * FROM storyboards WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,id])).rows[0];
      if(!board)throw new HttpError(404,"Storyboard not found");
      const take=(await client.query("SELECT t.*,r.state,r.output_ids FROM storyboard_still_takes t JOIN runs r ON r.workspace_id=t.workspace_id AND r.id=t.child_run_id WHERE t.workspace_id=$1 AND t.storyboard_id=$2 AND t.id=$3 FOR UPDATE OF t",[workspaceId,id,takeId])).rows[0];
      if(!take)throw new HttpError(404,"Still take not found");
      if(!(await client.query("SELECT id FROM shots WHERE workspace_id=$1 AND storyboard_id=$2 AND plan_key=$3 AND prompt=$4",[workspaceId,id,take.plan_key,take.prompt])).rowCount)throw new HttpError(409,"The shot prompt or identity changed; generate a new still");
      if(take.rejected_at)throw new HttpError(409,"This candidate was rejected; generate a new take");
      if(take.state!=="succeeded"||take.output_ids?.length!==1)throw new HttpError(422,"Approve only a completed single-image still");
      const assetId=take.output_ids[0];
      if(!(await client.query("SELECT id FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND media_type='image'",[workspaceId,board.project_id,assetId])).rowCount)throw new HttpError(422,"Still output is unavailable in this project");
      if(take.approved_at&&take.approved_asset_id!==assetId)throw new HttpError(409,"The approved output no longer matches its producing run");
      if(!take.approved_at)await client.query("UPDATE storyboard_still_takes SET approved_asset_id=$1,approved_by=$2,approved_at=clock_timestamp() WHERE workspace_id=$3 AND id=$4",[assetId,user.id,workspaceId,takeId]);
      return {id:takeId,approved_asset_id:assetId};
    });
  });
  app.post(`${base}/storyboards/:id/stills/:takeId/reject`,async request=>{
    const {workspaceId,id,takeId}=item.extend({takeId:z.uuid()}).parse(request.params),user=await member(pool,request,workspaceId,"creator");
    z.object({}).strict().parse(request.body??{});
    return transaction(pool,async client=>{
      if(!(await client.query("SELECT id FROM storyboards WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,id])).rowCount)throw new HttpError(404,"Storyboard not found");
      const take=(await client.query("SELECT t.*,r.state FROM storyboard_still_takes t JOIN runs r ON r.workspace_id=t.workspace_id AND r.id=t.child_run_id WHERE t.workspace_id=$1 AND t.storyboard_id=$2 AND t.id=$3 FOR UPDATE OF t",[workspaceId,id,takeId])).rows[0];
      if(!take)throw new HttpError(404,"Still take not found");
      if(take.approved_at)throw new HttpError(409,"An approved frame is immutable; approve a new take to replace it");
      if(take.state!=="succeeded")throw new HttpError(422,"Only a completed candidate can be rejected");
      if(!take.rejected_at)await client.query("UPDATE storyboard_still_takes SET rejected_by=$1,rejected_at=clock_timestamp() WHERE workspace_id=$2 AND id=$3",[user.id,workspaceId,takeId]);
      return {id:takeId,rejected:true};
    });
  });

}

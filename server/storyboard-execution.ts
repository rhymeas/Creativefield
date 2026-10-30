import type {FastifyInstance} from "fastify";
import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import type {CapabilityBundle} from "../src/capabilities/types";
import {member,HttpError} from "./auth";
import {transaction} from "./db";
import {hashToken,newId} from "./crypto";
import type {DiskStore} from "./storage";
import {assemblySchema,assembleVideo,assemblyReadiness,AssemblyError,type AssemblySettings} from "./assembly";
import {canonical,prepareInvocation,enqueuePreparedRun,cancelRun,scalarControls,type PreparedRun} from "./run-submission";
import {storyboardStillRoutes,approvedStoryboardStill} from "./storyboard-stills";
import {storyboardTiming} from "./storyboard-timing";
import {filmName} from "../src/team/media-names";

export const generationSchema=z.object({capabilityId:z.string().max(120),version:z.string().max(40),routeId:z.literal("local"),controls:scalarControls.default({})}).strict();
const base="/api/v1/workspaces/:workspaceId",ws=z.object({workspaceId:z.uuid()}),item=ws.extend({id:z.uuid()});
const active=["pending","generating","assembling","cancel_requested"],childActive=["pending","submitting","submission_unknown","queued","running","cancel_requested"];
const columns="id,project_id,storyboard_id,revision,worker_id,created_by,assembly,state,error,output_asset_id,created_at,updated_at";
async function setState(client:PoolClient,r:any,state:string,error:string|null=null){
  await client.query("UPDATE storyboard_renders SET state=$1,error=$2,updated_at=now() WHERE workspace_id=$3 AND id=$4",[state,error,r.workspace_id,r.id]);
  await client.query("INSERT INTO storyboard_render_events(workspace_id,render_id,state,detail) VALUES($1,$2,$3,$4)",[r.workspace_id,r.id,state,JSON.stringify(error?{error}:{})]);
}

export class StoryboardService{
  private inFlight:Promise<void>|null=null;
  private stopped=false;
  private assemblyAbort=new Map<string,AbortController>();
  constructor(readonly pool:Pool,readonly store:DiskStore){}
  tick():Promise<void>{if(this.stopped)return Promise.resolve();if(this.inFlight)return this.inFlight;this.inFlight=this.reconcile().finally(()=>{this.inFlight=null;});return this.inFlight;}
  async close(){this.stopped=true;for(const a of this.assemblyAbort.values())a.abort();await this.inFlight;}
  interrupt(id:string){this.assemblyAbort.get(id)?.abort();}
  private async reconcile(){
    const renders=(await this.pool.query("SELECT id FROM storyboard_renders WHERE state=ANY($1::text[]) ORDER BY created_at",[active])).rows;
    for(const {id} of renders){
      if(this.stopped)break;
      const lock=await this.pool.connect();
      try{
        if(!(await lock.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",[`storyboard:${id}`])).rows[0].acquired)continue;
        try{await this.advance(id);}catch{/* A DB outage leaves durable state for next reconciliation. */}
        finally{await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[`storyboard:${id}`]);}
      }finally{lock.release();}
    }
  }
  private async advance(id:string){
    const ready=await transaction(this.pool,async client=>{
      const r=(await client.query("SELECT * FROM storyboard_renders WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if(!r||!active.includes(r.state))return null;
      const shots=(await client.query("SELECT s.*,r.state AS child_state,r.output_ids FROM storyboard_render_shots s LEFT JOIN runs r ON r.workspace_id=s.workspace_id AND r.id=s.child_run_id WHERE s.workspace_id=$1 AND s.render_id=$2 ORDER BY ordinal",[r.workspace_id,r.id])).rows;
      if(r.state==="cancel_requested"){
        for(const s of shots)if(childActive.includes(s.child_state))await cancelRun(client,r.workspace_id,s.child_run_id);
        if(!shots.some(s=>childActive.includes(s.child_state)))await setState(client,r,"canceled");
        return null;
      }
      for(const s of shots){
        if(!s.child_run_id){
          const prepared=s.prepared as PreparedRun,key=`storyboard:${r.id}:${s.ordinal}`;
          const child=await enqueuePreparedRun(client,r.workspace_id,r.created_by,prepared,key,hashToken(canonical(prepared)),{scene:1,shot:s.ordinal+1});
          await client.query("UPDATE storyboard_render_shots SET child_run_id=$1 WHERE workspace_id=$2 AND render_id=$3 AND ordinal=$4",[child.id,r.workspace_id,r.id,s.ordinal]);
          await setState(client,r,"generating");return null;
        }
        if(childActive.includes(s.child_state))return null;
        if(s.child_state!=="succeeded"){await setState(client,r,"failed",`Shot ${s.ordinal+1} ${s.child_state??"is unavailable"}; later shots were not submitted`);return null;}
        if(!s.output_asset_id){
          const output=s.output_ids?.[0];
          if(!output||!(await client.query("SELECT id FROM assets WHERE workspace_id=$1 AND id=$2 AND media_type='video'",[r.workspace_id,output])).rowCount){await setState(client,r,"failed",`Shot ${s.ordinal+1} has no verified video artifact`);return null;}
          await client.query("UPDATE storyboard_render_shots SET output_asset_id=$1 WHERE workspace_id=$2 AND render_id=$3 AND ordinal=$4",[output,r.workspace_id,r.id,s.ordinal]);s.output_asset_id=output;
        }
      }
      if(r.state!=="assembling")await setState(client,r,"assembling");
      const clips=[];
      for(const s of shots){const asset=(await client.query("SELECT storage_key FROM assets WHERE workspace_id=$1 AND id=$2",[r.workspace_id,s.output_asset_id])).rows[0];clips.push({key:asset.storage_key,frames:s.snapshot.frames});}
      return {render:r,clips};
    });
    if(!ready||this.stopped)return;
    const {render:r,clips}=ready,controller=new AbortController();this.assemblyAbort.set(id,controller);
    // A second server can receive cancellation; observe the durable state too.
    const timer=setInterval(()=>{void this.pool.query("SELECT state FROM storyboard_renders WHERE id=$1",[id]).then(q=>{if(q.rows[0]?.state!=="assembling")controller.abort();}).catch(()=>controller.abort());},500);
    let saved:Awaited<ReturnType<typeof assembleVideo>>|undefined,published=false;
    try{
      saved=await assembleVideo(this.store,r.workspace_id,clips,r.assembly as AssemblySettings,controller.signal);
      await transaction(this.pool,async client=>{
        const current=(await client.query("SELECT state FROM storyboard_renders WHERE id=$1 FOR UPDATE",[id])).rows[0];
        if(current?.state!=="assembling"||this.stopped)return;
        const board=(await client.query("SELECT b.name,p.name AS project FROM storyboards b LEFT JOIN projects p ON p.workspace_id=b.workspace_id AND p.id=b.project_id WHERE b.workspace_id=$1 AND b.id=$2",[r.workspace_id,r.storyboard_id])).rows[0];
        const assetId=newId();
        await client.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata) VALUES($1,$2,$3,$4,'video','video/mp4',$5,$6,$7,$8,$9)",[assetId,r.workspace_id,r.project_id,filmName(board?.name||board?.project,r.revision),saved!.key,saved!.sha256,saved!.bytes,r.created_by,JSON.stringify({...saved!.metadata,storyboardRenderId:id,storyboardRevision:r.revision})]);
        await client.query("UPDATE storyboard_renders SET output_asset_id=$1 WHERE id=$2",[assetId,id]);await setState(client,r,"succeeded");published=true;
      });
    }catch(e){
      if(!this.stopped)await transaction(this.pool,async client=>{
        const current=(await client.query("SELECT state FROM storyboard_renders WHERE id=$1 FOR UPDATE",[id])).rows[0];
        if(current?.state==="assembling")await setState(client,r,"assembly_failed",e instanceof AssemblyError?e.message:"Assembly failed; check the team server storage and finishing requirements");
      });
    }finally{
      clearInterval(timer);this.assemblyAbort.delete(id);
      if(saved&&!published)await this.store.remove(r.workspace_id,saved.key).catch(()=>{});
    }
  }
}

export async function storyboardExecutionRoutes(app:FastifyInstance,pool:Pool,store:DiskStore,catalogue:CapabilityBundle[]){
  const service=new StoryboardService(pool,store);
  await storyboardStillRoutes(app,pool,catalogue);
  app.get(`${base}/storyboard-requirements`,async request=>{const {workspaceId}=ws.parse(request.params);await member(pool,request,workspaceId);return assemblyReadiness();});
  app.post(`${base}/storyboards/:id/renders`,async request=>{
    const {workspaceId,id}=item.parse(request.params),user=await member(pool,request,workspaceId,"creator");
    const body=z.object({revision:z.number().int().positive(),workerId:z.uuid(),idempotencyKey:z.string().min(8).max(128),assembly:assemblySchema,approvedStillTakes:z.record(z.uuid(),z.uuid()).optional()}).strict().parse(request.body);
    const hash=hashToken(canonical({storyboardId:id,...body}));
    return transaction(pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`storyboard-request:${workspaceId}/${body.idempotencyKey}`]);
      const old=(await client.query(`SELECT ${columns},request_hash FROM storyboard_renders WHERE workspace_id=$1 AND idempotency_key=$2`,[workspaceId,body.idempotencyKey])).rows[0];
      if(old){if(old.request_hash!==hash)throw new HttpError(409,"Idempotency key was already used for another storyboard request");delete old.request_hash;return old;}
      const board=(await client.query("SELECT * FROM storyboards WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,id])).rows[0];
      if(!board)throw new HttpError(404,"Storyboard not found");
      if(board.revision!==body.revision)throw new HttpError(409,"Storyboard changed; reload before rendering");
      const readiness=await assemblyReadiness();if(readiness.state!=="ready")throw new HttpError(422,readiness.state==="install_required"?`Assembly installation required: ${readiness.missing.join(", ")}. ${readiness.instructions}`:`Assembly check incomplete. ${readiness.instructions}`);
      const shots=(await client.query("SELECT * FROM shots WHERE workspace_id=$1 AND storyboard_id=$2 ORDER BY ordinal",[workspaceId,id])).rows;
      if(!shots.length||shots.length>32||shots.reduce((n,s)=>n+Number(s.duration_seconds),0)>300)throw new HttpError(422,"Choose 1–32 shots totaling no more than 300 seconds");
      if(body.approvedStillTakes&&(Object.keys(body.approvedStillTakes).length!==shots.length||shots.some(s=>!body.approvedStillTakes![s.plan_key])))throw new HttpError(422,"Approve one current still for every shot before animating");
      const prepared=[];
      for(const shot of shots){
        const selected=generationSchema.safeParse(shot.settings.generation);
        if(!selected.success)throw new HttpError(422,`Shot ${shot.ordinal+1} needs an explicit local generation workflow`);
        let g=selected.data,b=catalogue.find(b=>b.manifest.id===g.capabilityId);
        if(!b||!["t2v","i2v","flf2v"].includes(b.manifest.category)||!b.manifest.controls.some(c=>c.id==="length")||b.manifest.timing?.sourceTimed)throw new HttpError(422,"This storyboard route requires a duration-controlled video generation workflow");
        if(shot.settings.cameraHint?.trim())throw new HttpError(422,"Camera hints are not bound; add the description to the shot prompt explicitly");
        if("prompt" in g.controls||"length" in g.controls)throw new HttpError(400,"Shot prompt and duration must be set on the shot, not overridden in controls");
        const assets=(await client.query("SELECT role,asset_id FROM shot_assets WHERE workspace_id=$1 AND shot_id=$2",[workspaceId,shot.id])).rows;
        const inputs=Object.fromEntries(assets.map(a=>[a.role,a.asset_id]));
        const elementInputs={...(shot.settings.elementInputs??{})};
        let approval:Record<string,unknown>|undefined;
        if(body.approvedStillTakes){
          if(!b.manifest.inputs.some(p=>p.id==="start_image"&&p.type==="image")){
            /* A text-to-video shot can still animate its approved still when the same family has
               an image-to-video sibling; resolve it here because this is where the run is prepared. */
            const base=g.capabilityId.endsWith("-t2v")?g.capabilityId.slice(0,-4):undefined;
            const sibling=base?catalogue.find(x=>x.manifest.id===base&&x.manifest.inputs.some(p=>p.id==="start_image"&&p.type==="image")&&x.manifest.controls.some(c=>c.id==="length")&&!x.manifest.timing?.sourceTimed):undefined;
            if(!sibling)throw new HttpError(422,"Animate approved requires a workflow with a start image input");
            b=sibling;g={...g,capabilityId:sibling.manifest.id,version:sibling.manifest.version};
          }
          const still=await approvedStoryboardStill(client,workspaceId,board,shot,body.approvedStillTakes[shot.plan_key]);
          inputs.start_image=still.approved_asset_id;delete elementInputs.start_image;
          const previous=assets.findIndex(a=>a.role==="start_image");if(previous>=0)assets.splice(previous,1);
          assets.push({role:"start_image",asset_id:still.approved_asset_id});
          approval={takeId:still.id,assetId:still.approved_asset_id,approvedBy:still.approved_by,approvedAt:still.approved_at,producerRunId:still.child_run_id};
        }
        const timing=storyboardTiming(b.manifest,Number(shot.duration_seconds),body.assembly.fps);
        const run=await prepareInvocation(client,catalogue,workspaceId,{projectId:board.project_id,workerId:body.workerId,idempotencyKey:body.idempotencyKey,capabilityId:g.capabilityId,version:g.version,routeId:g.routeId,inputs,elementInputs,controls:{...g.controls,prompt:shot.prompt,length:timing.controlSeconds},audioPolicy:shot.settings.audioPolicy??"mute"});
        prepared.push({run,snapshot:{sourceShotId:shot.id,planKey:shot.plan_key,...(approval?{approvedStill:approval}:{}),prompt:shot.prompt,durationSeconds:Number(shot.duration_seconds),...timing,assets,settings:shot.settings}});
      }
      const renderId=newId();
      const result=(await client.query(`INSERT INTO storyboard_renders(id,workspace_id,project_id,storyboard_id,revision,worker_id,created_by,idempotency_key,request_hash,assembly,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING ${columns}`,[renderId,workspaceId,board.project_id,id,body.revision,body.workerId,user.id,body.idempotencyKey,hash,JSON.stringify(body.assembly)])).rows[0];
      for(const [ordinal,p] of prepared.entries())await client.query("INSERT INTO storyboard_render_shots(workspace_id,render_id,ordinal,snapshot,prepared,workflow_revision_id) VALUES($1,$2,$3,$4,$5,$6)",[workspaceId,renderId,ordinal,JSON.stringify(p.snapshot),JSON.stringify(p.run),p.run.revisionId]);
      await client.query("INSERT INTO storyboard_render_events(workspace_id,render_id,state) VALUES($1,$2,'pending')",[workspaceId,renderId]);return result;
    });
  });
  app.get(`${base}/storyboards/:id/renders`,async request=>{const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId);return (await pool.query(`SELECT ${columns} FROM storyboard_renders WHERE workspace_id=$1 AND storyboard_id=$2 ORDER BY created_at DESC LIMIT 100`,[workspaceId,id])).rows;});
  app.get(`${base}/storyboard-renders/:id`,async request=>{
    const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId);
    const render=(await pool.query(`SELECT ${columns} FROM storyboard_renders WHERE workspace_id=$1 AND id=$2`,[workspaceId,id])).rows[0];if(!render)throw new HttpError(404,"Storyboard render not found");
    const shots=(await pool.query("SELECT s.ordinal,s.snapshot,s.workflow_revision_id,s.child_run_id,s.output_asset_id,s.prepared->'invocation' AS invocation,r.state AS state,r.error,r.scene,r.shot,r.take FROM storyboard_render_shots s LEFT JOIN runs r ON r.workspace_id=s.workspace_id AND r.id=s.child_run_id WHERE s.workspace_id=$1 AND s.render_id=$2 ORDER BY ordinal",[workspaceId,id])).rows;
    return {...render,shots};
  });
  app.get(`${base}/storyboard-renders/:id/events`,async request=>{const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId);const {after}=z.object({after:z.coerce.number().int().min(0).default(0)}).parse(request.query);return (await pool.query("SELECT seq,state,detail,created_at FROM storyboard_render_events WHERE workspace_id=$1 AND render_id=$2 AND seq>$3 ORDER BY seq LIMIT 200",[workspaceId,id,after])).rows;});
  for(const operation of ["cancel","retry-assembly"] as const)app.post(`${base}/storyboard-renders/:id/${operation}`,async request=>{
    const {workspaceId,id}=item.parse(request.params),user=await member(pool,request,workspaceId,"creator");
    const result=await transaction(pool,async client=>{
      const r=(await client.query("SELECT * FROM storyboard_renders WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,id])).rows[0];if(!r)throw new HttpError(404,"Storyboard render not found");
      if(user.role!=="admin"&&r.created_by!==user.id)throw new HttpError(403,"Only the render owner or an administrator may change execution");
      if(operation==="retry-assembly"){
        if(r.state!=="assembly_failed")throw new HttpError(409,"Only failed assembly can be retried without regeneration");
        await setState(client,r,"assembling");return {state:"assembling"};
      }
      if([...active,"assembly_failed"].includes(r.state)){
        await setState(client,r,"cancel_requested");
        const children=(await client.query("SELECT child_run_id FROM storyboard_render_shots WHERE workspace_id=$1 AND render_id=$2 AND child_run_id IS NOT NULL",[workspaceId,id])).rows;
        for(const child of children)await cancelRun(client,workspaceId,child.child_run_id);
        return {state:"cancel_requested"};
      }
      return {state:r.state};
    });
    if(operation==="cancel")service.interrupt(id);return result;
  });
  return service;
}

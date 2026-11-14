import type {Pool,PoolClient} from "pg";
import {transaction} from "./db";
import type {DiskStore} from "./storage";
import {cancelRun,canonical,enqueuePreparedRun,type PreparedRun} from "./run-submission";
import {hashToken,newId} from "./crypto";
import {cleanupVideoStitchAttempt,stitchVideoExtension,VideoStitchError} from "./video-stitch";
import type {VideoExtensionPlan} from "./video-extension-plan";

const active=["pending","generating","stitching","cancel_requested"],childActive=["pending","submitting","submission_unknown","queued","running","cancel_requested"];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
async function setState(client:PoolClient,job:any,state:string,error:string|null=null,detail:Record<string,unknown>={}){
  await client.query("UPDATE video_extension_jobs SET state=$1,error=$2,updated_at=now() WHERE workspace_id=$3 AND id=$4",[state,error,job.workspace_id,job.id]);
  await client.query("INSERT INTO video_extension_events(workspace_id,job_id,state,detail) VALUES($1,$2,$3,$4)",[job.workspace_id,job.id,state,JSON.stringify(error?{...detail,error}:detail)]);
}

export class VideoExtensionService{
  private inFlight:Promise<void>|null=null;
  private stopped=false;
  private stitchAbort=new Map<string,AbortController>();
  constructor(readonly pool:Pool,readonly store:DiskStore){}
  tick():Promise<void>{if(this.stopped)return Promise.resolve();if(this.inFlight)return this.inFlight;this.inFlight=this.reconcile().finally(()=>{this.inFlight=null;});return this.inFlight;}
  interrupt(id:string){this.stitchAbort.get(id)?.abort();}
  async close(){this.stopped=true;for(const controller of this.stitchAbort.values())controller.abort();await this.inFlight;}
  private async reconcile(){
    const jobs=(await this.pool.query("SELECT id FROM video_extension_jobs WHERE state=ANY($1::text[]) ORDER BY created_at",[active])).rows;
    for(const {id} of jobs){
      if(this.stopped)break;const lock=await this.pool.connect();
      try{if(!(await lock.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",[`video-extension:${id}`])).rows[0].acquired)continue;try{await this.advance(id);}catch{/* Durable state is retried after transient database/tool failure. */}finally{await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[`video-extension:${id}`]);}}finally{lock.release();}
    }
  }
  private async advance(id:string){
    const ready=await transaction(this.pool,async client=>{
      const job=(await client.query("SELECT * FROM video_extension_jobs WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if(!job||!active.includes(job.state))return null;
      const stages=(await client.query("SELECT s.*,r.state AS child_state,r.output_ids FROM video_extension_stages s LEFT JOIN runs r ON r.workspace_id=s.workspace_id AND r.id=s.child_run_id WHERE s.workspace_id=$1 AND s.job_id=$2 ORDER BY ordinal",[job.workspace_id,job.id])).rows;
      if(job.state==="cancel_requested"){
        for(const stage of stages)if(stage.child_run_id&&childActive.includes(stage.child_state))await cancelRun(client,job.workspace_id,stage.child_run_id);
        if(stages.some(stage=>stage.child_run_id&&childActive.includes(stage.child_state)))return null;
        const detail=stages.find(stage=>stage.kind==="stitch")?.detail??{},attempt=UUID.test(detail.attemptId)&&UUID.test(detail.candidateId)?{attemptId:detail.attemptId,candidateId:detail.candidateId}:null;
        return {cancel:{job,attempt}};
      }
      const generate=stages.find(stage=>stage.kind==="generate");
      if(generate){
        if(!generate.child_run_id){
          const prepared=generate.prepared as PreparedRun,key=`video-extension:${job.id}:generate`;
          const child=await enqueuePreparedRun(client,job.workspace_id,job.created_by,prepared,key,hashToken(canonical(prepared)));
          await client.query("UPDATE video_extension_stages SET child_run_id=$1,state='running' WHERE workspace_id=$2 AND job_id=$3 AND ordinal=$4",[child.id,job.workspace_id,job.id,generate.ordinal]);
          await setState(client,job,"generating");return null;
        }
        if(childActive.includes(generate.child_state))return null;
        if(generate.child_state!=="succeeded"){await client.query("UPDATE video_extension_stages SET state='failed' WHERE workspace_id=$1 AND job_id=$2 AND ordinal=$3",[job.workspace_id,job.id,generate.ordinal]);await setState(client,job,"failed",`Continuation child ${generate.child_state??"is unavailable"}`);return null;}
        if(!generate.output_asset_id){
          const output=generate.output_ids?.[0],asset=output?(await client.query("SELECT id FROM assets WHERE workspace_id=$1 AND id=$2 AND project_id=$3 AND media_type='video'",[job.workspace_id,output,job.project_id])).rows[0]:undefined;
          if(!asset){await setState(client,job,"failed","Continuation child has no verified project video artifact");return null;}
          await client.query("UPDATE video_extension_stages SET output_asset_id=$1,state='succeeded' WHERE workspace_id=$2 AND job_id=$3 AND ordinal=$4",[output,job.workspace_id,job.id,generate.ordinal]);generate.output_asset_id=output;
        }
      }
      const stitch=stages.find(stage=>stage.kind==="stitch");if(!stitch)throw new Error("Video extension stitch stage is missing");
      const resuming=job.state==="stitching"&&stitch.state==="running",prior=stitch.detail??{};
      const attempt={attemptId:resuming&&UUID.test(prior.attemptId)?prior.attemptId:newId(),candidateId:resuming&&UUID.test(prior.candidateId)?prior.candidateId:newId()};
      if(!resuming||attempt.attemptId!==prior.attemptId||attempt.candidateId!==prior.candidateId){
        await client.query("UPDATE video_extension_stages SET state='running',detail=$1 WHERE workspace_id=$2 AND job_id=$3 AND ordinal=$4",[JSON.stringify({...prior,...attempt}),job.workspace_id,job.id,stitch.ordinal]);await setState(client,job,"stitching",null,{attemptId:attempt.attemptId});
      }
      const source=(await client.query("SELECT storage_key,sha256 FROM assets WHERE workspace_id=$1 AND id=$2 AND project_id=$3",[job.workspace_id,job.source_asset_id,job.project_id])).rows[0];
      const continuation=generate?.output_asset_id?(await client.query("SELECT storage_key,sha256 FROM assets WHERE workspace_id=$1 AND id=$2",[job.workspace_id,generate.output_asset_id])).rows[0]:null;
      if(!source)throw new Error("Video extension source asset is unavailable");
      return {job,stitch,generate,source,continuation,attempt};
    });
    if(!ready||this.stopped)return;
    if(ready.cancel){
      const {job,attempt}=ready.cancel;if(attempt)await cleanupVideoStitchAttempt(this.store,job.workspace_id,attempt);
      await transaction(this.pool,async client=>{const current=(await client.query("SELECT state FROM video_extension_jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[job.workspace_id,id])).rows[0];if(current?.state==="cancel_requested")await setState(client,job,"canceled");});return;
    }
    const {job,stitch,generate,source,continuation,attempt}=ready,controller=new AbortController();this.stitchAbort.set(id,controller);
    const timer=setInterval(()=>{void this.pool.query("SELECT state FROM video_extension_jobs WHERE id=$1",[id]).then(result=>{if(result.rows[0]?.state!=="stitching")controller.abort();}).catch(()=>controller.abort());},500);
    let saved:Awaited<ReturnType<typeof stitchVideoExtension>>|undefined,published=false,publicationUncertain=false,assetId=newId();
    try{
      saved=await stitchVideoExtension(this.store,job.workspace_id,source.storage_key,job.plan as VideoExtensionPlan,continuation?.storage_key??null,controller.signal,attempt);
      try{
        published=await transaction(this.pool,async client=>{
          const current=(await client.query("SELECT state FROM video_extension_jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[job.workspace_id,id])).rows[0];
          if(current?.state!=="stitching"||this.stopped)return false;
          const metadata={...saved!.metadata,videoExtensionJobId:id,sourceAssetId:job.source_asset_id,childRunId:generate?.child_run_id??null,childArtifactSha256:continuation?.sha256??null,workerId:job.worker_id??null};
          await client.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,'video','video/mp4',$5,$6,$7,$8,$9,$10)",[assetId,job.workspace_id,job.project_id,`video-extension-${id}.mp4`,saved!.key,saved!.sha256,saved!.bytes,job.created_by,job.source_asset_id,JSON.stringify(metadata)]);
          await client.query("UPDATE video_extension_stages SET state='succeeded',output_asset_id=$1,detail=$2 WHERE workspace_id=$3 AND job_id=$4 AND ordinal=$5",[assetId,JSON.stringify({artifactSha256:saved!.sha256,planDigest:(job.plan as VideoExtensionPlan).planDigest}),job.workspace_id,id,stitch.ordinal]);
          await client.query("UPDATE video_extension_jobs SET output_asset_id=$1 WHERE workspace_id=$2 AND id=$3",[assetId,job.workspace_id,id]);await setState(client,job,"succeeded");return true;
        });
      }catch(error){
        try{
          const committed=(await this.pool.query("SELECT j.state,a.storage_key FROM video_extension_jobs j LEFT JOIN assets a ON a.workspace_id=j.workspace_id AND a.id=j.output_asset_id WHERE j.workspace_id=$1 AND j.id=$2",[job.workspace_id,id])).rows[0];
          if(committed?.state==="succeeded"&&committed.storage_key===saved.key)published=true;else throw error;
        }catch(readbackError){
          if(readbackError!==error)publicationUncertain=true;
          throw error;
        }
      }
    }catch(error){
      if(!this.stopped&&!publicationUncertain){
        await cleanupVideoStitchAttempt(this.store,job.workspace_id,attempt);
        await transaction(this.pool,async client=>{const current=(await client.query("SELECT state FROM video_extension_jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[job.workspace_id,id])).rows[0];if(current?.state==="stitching"){await client.query("UPDATE video_extension_stages SET state='failed' WHERE workspace_id=$1 AND job_id=$2 AND ordinal=$3",[job.workspace_id,id,stitch.ordinal]);await setState(client,job,"stitch_failed",error instanceof VideoStitchError?error.message:"Video stitch failed; verified child artifacts are preserved");}});
      }
    }finally{clearInterval(timer);this.stitchAbort.delete(id);if(saved&&!published&&!publicationUncertain)await this.store.remove(job.workspace_id,saved.key).catch(()=>{});}
  }
}


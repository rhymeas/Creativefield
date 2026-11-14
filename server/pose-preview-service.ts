import type {Pool,PoolClient} from "pg";
import type {CapabilityBundle} from "../src/capabilities/types";
import {HttpError} from "./auth";
import {transaction} from "./db";
import {cancelRun} from "./run-submission";
import {preparePosePreview} from "./pose-preview-preparation";
import {motionReceiptSchema} from "./motion-media";
import type {DiskStore} from "./storage";

const TERMINAL_RETENTION_MS=24*60*60*1000;
const CLEANUP_INTERVAL_MS=5*60*1000;
type PosePreviewRow={id:string;workspace_id:string;state:string;run_id:string|null;normalized_receipt:unknown;normalization_candidate_id:string|null;source_asset_id:string;updated_at:Date};

/** Uses the app's existing scheduler; never starts a background timer itself. */
export class PosePreviewService{
  private work?:Promise<void>;
  private stopped=false;
  private active=new Map<string,AbortController>();
  private lastCleanup=0;
  constructor(private pool:Pool,private store:DiskStore,private catalogue:CapabilityBundle[]){} 
  interrupt(id:string){this.active.get(id)?.abort();}
  tick():Promise<void>{
    if(this.stopped)return Promise.resolve();
    if(this.work)return this.work;
    this.work=this.process().finally(()=>{this.work=undefined;});return this.work;
  }
  async close(){this.stopped=true;for(const controller of this.active.values())controller.abort();await this.work;}
  private async process(){
    if(Date.now()-this.lastCleanup>=CLEANUP_INTERVAL_MS){
      this.lastCleanup=Date.now();
      await cleanupPosePreviews(this.pool,this.store).catch(()=>{});
    }
    const jobs=(await this.pool.query("SELECT workspace_id,id FROM pose_previews WHERE state IN ('pending','preparing','queued','cancel_requested') ORDER BY created_at LIMIT 20")).rows;
    for(const job of jobs){
      if(this.stopped)return;
      const controller=new AbortController();this.active.set(job.id,controller);
      try{
        const row=(await this.pool.query("SELECT * FROM pose_previews WHERE workspace_id=$1 AND id=$2",[job.workspace_id,job.id])).rows[0];
        if(!row)continue;
        if(row.run_id){
          await transaction(this.pool,async client=>{
            const current=(await client.query("SELECT state,run_id FROM pose_previews WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[job.workspace_id,job.id])).rows[0];
            if(!current?.run_id)return;
            if(current.state==="cancel_requested")await cancelRun(client,job.workspace_id,current.run_id);
            const run=(await client.query("SELECT state,error FROM runs WHERE workspace_id=$1 AND id=$2",[job.workspace_id,current.run_id])).rows[0];
            if(!run)await client.query("UPDATE pose_previews SET state='failed',error=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state NOT IN ('succeeded','failed','canceled')",[job.workspace_id,job.id,"Pose detection job is missing. Start a new preview."]);
            else if(["succeeded","failed","canceled"].includes(run.state))await client.query("UPDATE pose_previews SET state=$3,error=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2",[job.workspace_id,job.id,run.state,run.state==="failed"?"Pose detection failed. Open the job details for more information.":null]);
          });
        }else if(row.state==="cancel_requested")await this.finishCancellation(row);
        else await preparePosePreview(this.pool,this.store,this.catalogue,job.workspace_id,job.id,controller.signal);
      }catch(error){
        // A stopped host preserves preparation for its replacement. A changed
        // cancellation/lease or an uncertain successful commit is not a failure.
        if(!controller.signal.aborted&&!(error instanceof HttpError&&error.statusCode===409)){
          const failed=await this.pool.query("UPDATE pose_previews SET state='failed',error=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state IN ('pending','preparing') AND run_id IS NULL",[job.workspace_id,job.id,error instanceof HttpError?error.message:"Pose preparation could not finish. Start a new preview."]);
          if(failed.rowCount)await this.discardFailedPreparation(job.workspace_id,job.id).catch(()=>{});
        }
      }finally{this.active.delete(job.id);}
    }
  }
  /** Failed preparation never published a run; discard only unpublished candidates. */
  private async discardFailedPreparation(workspaceId:string,id:string){
    const client=await this.pool.connect(),lock=`pose-preview-prepare:${workspaceId}/${id}`;let locked=false;
    try{
      locked=(await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",[lock])).rows[0].locked;
      if(!locked)return;
      const row=(await client.query("SELECT id,workspace_id,state,run_id,normalized_receipt,normalization_candidate_id,source_asset_id,updated_at FROM pose_previews WHERE workspace_id=$1 AND id=$2",[workspaceId,id])).rows[0] as PosePreviewRow|undefined;
      if(!row||row.state!=="failed"||row.run_id)return;
      if((await client.query("SELECT 1 FROM pose_preview_frames WHERE workspace_id=$1 AND preview_id=$2 AND asset_id IS NOT NULL LIMIT 1",[workspaceId,id])).rowCount)return;
      await discardUnpublishedCandidates(client,this.store,row);
    }finally{
      let broken=false;
      if(locked)await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[lock]).catch(()=>{broken=true;});
      client.release(broken);
    }
  }
  private async finishCancellation(job:{id:string;workspace_id:string;normalized_receipt:unknown}){
    const client=await this.pool.connect(),lock=`pose-preview-prepare:${job.workspace_id}/${job.id}`;let locked=false;
    try{
      locked=(await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",[lock])).rows[0].locked;
      if(!locked)return;
      const row=(await client.query("SELECT id,workspace_id,state,run_id,normalized_receipt,normalization_candidate_id,source_asset_id,updated_at FROM pose_previews WHERE workspace_id=$1 AND id=$2",[job.workspace_id,job.id])).rows[0] as PosePreviewRow|undefined;
      if(row?.state!=="cancel_requested"||row.run_id)return;
      await discardUnpublishedCandidates(client,this.store,row);
      await client.query("UPDATE pose_previews SET state='canceled',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state='cancel_requested' AND run_id IS NULL",[job.workspace_id,job.id]);
    }finally{
      let broken=false;
      if(locked)await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[lock]).catch(()=>{broken=true;});
      client.release(broken);
    }
  }
}

async function discardUnpublishedCandidates(client:PoolClient,store:DiskStore,job:{id:string;workspace_id:string;normalized_receipt:unknown;normalization_candidate_id:string|null}){
  const frames=(await client.query("SELECT planned_asset_id,asset_id,storage_key FROM pose_preview_frames WHERE workspace_id=$1 AND preview_id=$2",[job.workspace_id,job.id])).rows;
  for(const frame of frames){
    if(frame.asset_id||frame.storage_key!==`${job.workspace_id}/${frame.planned_asset_id}`)throw Error("Unsafe pose cleanup candidate");
    if((await client.query("SELECT id FROM assets WHERE workspace_id=$1 AND (id=$2 OR storage_key=$3)",[job.workspace_id,frame.planned_asset_id,frame.storage_key])).rowCount)throw Error("Pose candidate is published");
    await store.discardCandidate(job.workspace_id,frame.planned_asset_id);
  }
  const parsed=motionReceiptSchema.safeParse(job.normalized_receipt);
  const candidate=job.normalization_candidate_id;
  if(candidate){
    const key=`${job.workspace_id}/${candidate}`;
    const source=(await client.query("SELECT a.storage_key FROM pose_previews p JOIN assets a ON a.workspace_id=p.workspace_id AND a.id=p.source_asset_id WHERE p.workspace_id=$1 AND p.id=$2",[job.workspace_id,job.id])).rows[0];
    if(key===source?.storage_key||(parsed.success&&(parsed.data.workspaceId!==job.workspace_id||parsed.data.normalizedKey!==key||parsed.data.sourceKey===key)))throw Error("Unsafe normalized pose cleanup candidate");
    if(!(await client.query("SELECT id FROM assets WHERE workspace_id=$1 AND storage_key=$2",[job.workspace_id,key])).rowCount)await store.discardCandidate(job.workspace_id,key.split("/")[1]);
  }
}

/** Deletes only old failed/canceled previews with no child run and no published frame assets. */
export async function cleanupPosePreviews(pool:Pool,store:DiskStore,now=new Date()):Promise<number>{
  const cutoff=new Date(now.getTime()-TERMINAL_RETENTION_MS);
  const rows=(await pool.query("SELECT id,workspace_id FROM pose_previews p WHERE p.state IN ('failed','canceled') AND p.run_id IS NULL AND p.updated_at < $1 AND NOT EXISTS (SELECT 1 FROM pose_preview_frames f WHERE f.workspace_id=p.workspace_id AND f.preview_id=p.id AND f.asset_id IS NOT NULL) ORDER BY p.updated_at LIMIT 20",[cutoff])).rows;
  let removed=0;
  for(const candidate of rows){
    const client=await pool.connect(),lock=`pose-preview-prepare:${candidate.workspace_id}/${candidate.id}`;let locked=false;
    try{
      locked=(await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",[lock])).rows[0].locked;
      if(!locked)continue;
      const row=(await client.query("SELECT id,workspace_id,state,run_id,normalized_receipt,normalization_candidate_id,source_asset_id,updated_at FROM pose_previews WHERE workspace_id=$1 AND id=$2",[candidate.workspace_id,candidate.id])).rows[0] as PosePreviewRow|undefined;
      if(!row||!["failed","canceled"].includes(row.state)||row.run_id||row.updated_at>=cutoff)continue;
      if((await client.query("SELECT 1 FROM pose_preview_frames WHERE workspace_id=$1 AND preview_id=$2 AND asset_id IS NOT NULL LIMIT 1",[candidate.workspace_id,candidate.id])).rowCount)continue;
      await discardUnpublishedCandidates(client,store,row);
      await client.query("DELETE FROM pose_preview_frames WHERE workspace_id=$1 AND preview_id=$2",[candidate.workspace_id,candidate.id]);
      const deleted=await client.query("DELETE FROM pose_previews WHERE workspace_id=$1 AND id=$2 AND state IN ('failed','canceled') AND run_id IS NULL",[candidate.workspace_id,candidate.id]);
      removed+=deleted.rowCount??0;
    }catch{
      // A race, a published candidate or a storage error leaves the row for the next bounded pass.
    }finally{
      let broken=false;
      if(locked)await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[lock]).catch(()=>{broken=true;});
      client.release(broken);
    }
  }
  return removed;
}

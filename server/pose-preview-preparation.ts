import type {Pool,PoolClient} from "pg";
import {randomUUID} from "node:crypto";
import {Readable} from "node:stream";
import {stat} from "node:fs/promises";
import type {CapabilityBundle} from "../src/capabilities/types";
import {HttpError} from "./auth";
import {fileSha256} from "./masked-media";
import {motionReceiptSchema,normalizeMotionInput} from "./motion-media";
import {extractPoseSamples} from "./pose-preview-media";
import {enqueuePreparedRun,prepareInvocation} from "./run-submission";
import type {DiskStore} from "./storage";

/** Resume one persisted request. The session lock spans media I/O; row locks do not.
 * The caller schedules retries deliberately. Errors leave durable preparation intact,
 * so a disconnected process never turns an uncertain commit into a second run. */
export async function preparePosePreview(pool:Pool,store:DiskStore,catalogue:CapabilityBundle[],workspaceId:string,id:string,cancel?:AbortSignal){
  const client=await pool.connect(),owner=randomUUID(),controller=new AbortController();
  const signal=cancel?AbortSignal.any([cancel,controller.signal]):controller.signal;
  const lock=`pose-preview-prepare:${workspaceId}/${id}`;
  let locked=false,connectionFailed=false;
  const disconnected=()=>{connectionFailed=true;controller.abort();};
  client.on("error",disconnected);
  try{
    signal.throwIfAborted();
    locked=(await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",[lock])).rows[0].locked;
    if(!locked)return {state:"busy" as const};
    const job=(await client.query("SELECT * FROM pose_previews WHERE workspace_id=$1 AND id=$2",[workspaceId,id])).rows[0];
    if(!job)throw new HttpError(404,"Pose preview not found.");
    if(job.run_id||!["pending","preparing"].includes(job.state))return {state:job.state as string,runId:job.run_id as string|null};
    await client.query("UPDATE pose_previews SET state='preparing',lease_owner=$3,lease_expires_at=now()+interval '30 minutes',error=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",[workspaceId,id,owner]);
    const source=(await client.query("SELECT id,storage_key,sha256 FROM assets WHERE workspace_id=$1 AND id=$2 AND project_id=$3 AND media_type='video'",[workspaceId,job.source_asset_id,job.project_id])).rows[0];
    if(!source||source.sha256!==job.source_sha256||await fileSha256(await store.file(workspaceId,source.storage_key))!==job.source_sha256)throw new HttpError(422,"The driving clip changed. Choose it again.");
    let receipt=job.normalized_receipt?motionReceiptSchema.parse(job.normalized_receipt):undefined;
    if(!receipt){
      // A receipt cannot exist until normalization finishes. Journal its file
      // identity first so a crash in that gap does not create an unknown orphan.
      const candidate=job.normalization_candidate_id??randomUUID(),key=`${workspaceId}/${candidate}`;
      await inTransaction(client,async()=>{
        await fenced(client,workspaceId,id,owner,signal,true);
        if(key===source.storage_key||(await client.query("SELECT id FROM assets WHERE workspace_id=$1 AND (id=$2 OR storage_key=$3)",[workspaceId,candidate,key])).rowCount||(await client.query("SELECT id FROM pose_previews WHERE workspace_id=$1 AND id<>$2 AND normalized_receipt->>'normalizedKey'=$3",[workspaceId,id,key])).rowCount)throw new HttpError(422,"The pose preparation file is already in use.");
        await client.query("UPDATE pose_previews SET normalization_candidate_id=$4 WHERE workspace_id=$1 AND id=$2 AND lease_owner=$3",[workspaceId,id,owner,candidate]);
      });
      await fenced(client,workspaceId,id,owner,signal);
      await store.discardCandidate(workspaceId,candidate);
      receipt=await normalizeMotionInput(store,workspaceId,source.storage_key,signal,candidate);
      await fenced(client,workspaceId,id,owner,signal);
      await client.query("UPDATE pose_previews SET normalized_receipt=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND lease_owner=$3 AND state='preparing'",[workspaceId,id,owner,JSON.stringify(receipt)]);
    }
    if(receipt.workspaceId!==workspaceId||receipt.sourceKey!==source.storage_key||receipt.sourceSha256!==job.source_sha256)throw new HttpError(422,"The pose preparation belongs to a different driving clip.");
    const samples=await extractPoseSamples(store,workspaceId,receipt,signal);
    // Commit the full candidate plan before writing any frame file. A restart
    // reuses these identities and validates bytes, rather than allocating again.
    await inTransaction(client,async()=>{
      await fenced(client,workspaceId,id,owner,signal,true);
      const old=(await client.query("SELECT ordinal FROM pose_preview_frames WHERE workspace_id=$1 AND preview_id=$2",[workspaceId,id])).rows;
      if(!old.length)for(const [ordinal,frame] of samples.frames.entries()){
        const candidate=randomUUID();
        await client.query("INSERT INTO pose_preview_frames(workspace_id,preview_id,ordinal,planned_asset_id,storage_key,sha256,bytes,frame_index,seconds,width,height) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[workspaceId,id,ordinal,candidate,`${workspaceId}/${candidate}`,frame.sha256,frame.bytes.length,frame.frameIndex,frame.seconds,samples.width,samples.height]);
      }
    });
    const frames=(await client.query("SELECT * FROM pose_preview_frames WHERE workspace_id=$1 AND preview_id=$2 ORDER BY ordinal",[workspaceId,id])).rows;
    if(frames.length!==samples.frames.length||frames.some((frame,i)=>frame.ordinal!==i||frame.storage_key!==`${workspaceId}/${frame.planned_asset_id}`||frame.sha256!==samples.frames[i].sha256||Number(frame.bytes)!==samples.frames[i].bytes.length||frame.frame_index!==samples.frames[i].frameIndex||frame.seconds!==samples.frames[i].seconds||frame.width!==samples.width||frame.height!==samples.height))throw new HttpError(422,"The saved pose frame plan no longer matches the driving clip.");
    for(const [i,frame] of frames.entries()){
      await fenced(client,workspaceId,id,owner,signal);
      // Never replace an existing complete candidate, even if its hash is wrong.
      let present=false;
      try{
        const file=await store.file(workspaceId,frame.storage_key);
        present=true;
        if((await stat(file)).size!==Number(frame.bytes)||await fileSha256(file)!==frame.sha256)throw new HttpError(422,"A prepared pose frame changed. Start a new preview.");
      }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      if(!present){
        if(frame.asset_id||(await client.query("SELECT id FROM assets WHERE workspace_id=$1 AND (id=$2 OR storage_key=$3)",[workspaceId,frame.planned_asset_id,frame.storage_key])).rowCount)throw new HttpError(422,"A published pose frame is missing.");
        // Only this locked request owns the journaled, unpublished candidate.
        await store.discardCandidate(workspaceId,frame.planned_asset_id);
        const saved=await store.put(workspaceId,Readable.from(samples.frames[i].bytes),frame.planned_asset_id);
        if(saved.key!==frame.storage_key||saved.sha256!==frame.sha256||saved.bytes!==Number(frame.bytes))throw new HttpError(422,"The prepared pose frame could not be verified.");
      }
    }
    return await inTransaction(client,async()=>{
      await fenced(client,workspaceId,id,owner,signal,true);
      const count=frames.length,bundle=catalogue.find(entry=>entry.manifest.id===`sdpose-preview-${count}`);
      if(!bundle)throw new HttpError(422,"The installed pose workflow is unavailable.");
      for(const frame of frames){
        await client.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,'image','image/png',$5,$6,$7,$8,$9,$10)",[frame.planned_asset_id,workspaceId,job.project_id,`Driving frame ${frame.frame_index}`,frame.storage_key,frame.sha256,frame.bytes,job.created_by,source.id,JSON.stringify({width:frame.width,height:frame.height,posePreviewFrame:{previewId:id,frameIndex:frame.frame_index,seconds:frame.seconds}})]);
        await client.query("UPDATE pose_preview_frames SET asset_id=planned_asset_id WHERE workspace_id=$1 AND preview_id=$2 AND ordinal=$3",[workspaceId,id,frame.ordinal]);
      }
      await client.query("UPDATE pose_previews SET state='prepared' WHERE workspace_id=$1 AND id=$2",[workspaceId,id]);
      const key=`pose-preview:${id}`,prepared=await prepareInvocation(client,catalogue,workspaceId,{projectId:job.project_id,workerId:job.worker_id,idempotencyKey:key,capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:Object.fromEntries(frames.map((frame,i)=>[`frame_${i}`,frame.planned_asset_id])),controls:{},audioPolicy:"mute"},store);
      const run=await enqueuePreparedRun(client,workspaceId,job.created_by,prepared,key,job.request_hash);
      await client.query("UPDATE pose_previews SET state='queued',run_id=$4,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND lease_owner=$3",[workspaceId,id,owner,run.id]);
      return {state:"queued" as const,runId:run.id as string};
    });
  }finally{
    if(locked&&!connectionFailed)await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[lock]).catch(()=>{connectionFailed=true;});
    client.removeListener("error",disconnected);client.release(connectionFailed);
  }
}

async function fenced(client:PoolClient,workspaceId:string,id:string,owner:string,signal:AbortSignal,lockRow=false){
  signal.throwIfAborted();
  const current=(await client.query(`SELECT state,lease_owner,lease_expires_at FROM pose_previews WHERE workspace_id=$1 AND id=$2${lockRow?" FOR UPDATE":""}`,[workspaceId,id])).rows[0];
  if(current?.state!=="preparing"||current.lease_owner!==owner||new Date(current.lease_expires_at).getTime()<=Date.now())throw new HttpError(409,"Pose preparation was canceled or ownership changed.");
}

async function inTransaction<T>(client:PoolClient,work:()=>Promise<T>):Promise<T>{
  await client.query("BEGIN");
  try{const value=await work();await client.query("COMMIT");return value;}
  catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}
}

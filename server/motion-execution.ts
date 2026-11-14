import type {Pool} from "pg";
import type {CapabilityBundle,CapabilityManifestV2,Invocation} from "../src/capabilities/types";
import {compileLocal} from "../src/capabilities/compile";
import {compileWanAnimateMotion,planWanAnimateFrames} from "../src/capabilities/motion";
import type {ApiGraph} from "../src/workflow/build";
import {firstOutputFile,type HistoryEntry} from "../src/comfy/client";
import {HttpError} from "./auth";
import {hashToken,newId} from "./crypto";
import {transaction} from "./db";
import {MediaProbeUnavailableError} from "./media";
import {fileSha256} from "./masked-media";
import {
  MOTION_MEDIA_VERSION,motionReceiptSchema,normalizeMotionInput,verifyMotionOutput,
  type MotionMediaReceipt,type MotionOutputVerification,
} from "./motion-media";
import {canonical} from "./run-submission";
import type {DiskStore} from "./storage";

/**
 * Durable Wan Animate motion preparation (EDT-04b2).
 *
 * The motion_preparations ledger is the authoritative record for the strict
 * 24-CFR normalization of a run's driving video and for the single ComfyUI
 * POST attempt. The owning run stays `pending` while FFmpeg work runs; no
 * PostgreSQL transaction is held across probing, hashing or storage I/O.
 * Immediately before the first POST, commitGraphAndMarkPost persists the
 * compiled graph, its deterministic digest and the POST-attempt marker in one
 * transaction. After that marker exists the run is never POSTed again: an
 * ambiguous outcome reconciles through the existing client_id/run metadata.
 * A run found in `submitting` with no marker provably never POSTed, so it is
 * returned to `pending` and submitted exactly once on a later tick.
 */

/** Lease must exceed one bounded normalize+verify cycle (600s each at most). */
export const MOTION_PREPARATION_LEASE_MS=30*60*1000;

export type MotionPreparationState="pending"|"preparing"|"prepared"|"submitted"|"failed"|"canceled";
export type MotionPreparationRow={
  workspaceId:string;runId:string;state:MotionPreparationState;normalizationVersion:number;
  sourceAssetId:string|null;sourceStorageKey:string|null;sourceSha256:string|null;sourceBytes:number|null;
  normalizedStorageKey:string|null;normalizedSha256:string|null;normalizedBytes:number|null;
  receipt:MotionMediaReceipt|null;graphDigest:string|null;postAttemptedAt:string|null;
  attempt:number;leaseOwner:string|null;leaseExpiresAt:string|null;error:string|null;
};
export type MotionSourceIdentity={assetId:string;storageKey:string;sha256:string;bytes:number};
export type MotionContract=NonNullable<CapabilityManifestV2["motionContract"]>;

export function motionContractFor(manifest:CapabilityManifestV2):MotionContract|undefined{
  return manifest.motionContract?.kind==="wan_animate_motion_v1"?manifest.motionContract:undefined;
}
export function graphDigest(graph:ApiGraph):string{return hashToken(canonical(graph));}

/** Compile the final graph only from the persisted, reverified normalized receipt. */
export function compileMotionGraph(bundle:CapabilityBundle,invocation:Invocation,inputs:Record<string,string>,receipt:MotionMediaReceipt):{graph:ApiGraph;digest:string}{
  if(invocation.audioPolicy!=="mute")throw new Error("Wan Animate motion transfer produces silent video; use the mute audio policy");
  const graph=compileWanAnimateMotion(compileLocal(bundle,{...invocation,inputs},{allowExperimental:true}),planWanAnimateFrames(receipt.decodedFrameCount));
  return {graph,digest:graphDigest(graph)};
}

/** Expected strict output envelope: output dimensions come from the frozen
 * invocation controls, frame count and timing from the normalized receipt.
 * Wan's latent grid rounds the requested size down to multiples of 16, so the
 * expected envelope uses that same grid instead of the nominal request.
 * Never pass the receipt itself as the expected envelope: its normalized hash
 * must not be required of the generated output. */
export function expectedMotionOutput(manifest:CapabilityManifestV2,invocation:Invocation,receipt:MotionMediaReceipt):{width:number;height:number;decodedFrameCount:number;timingDigest:string}{
  const width=invocation.controls.width??manifest.controls.find(c=>c.id==="width")?.default;
  const height=invocation.controls.height??manifest.controls.find(c=>c.id==="height")?.default;
  if(!Number.isInteger(width)||!Number.isInteger(height))throw new Error("Motion output dimensions are unavailable");
  const grid=(value:number)=>Math.floor(value/16)*16;
  const outputWidth=grid(width as number),outputHeight=grid(height as number);
  if(outputWidth<16||outputHeight<16)throw new Error("Motion output dimensions are too small");
  return {width:outputWidth,height:outputHeight,decodedFrameCount:receipt.decodedFrameCount,timingDigest:receipt.timingDigest};
}

type OutputFile=NonNullable<ReturnType<typeof firstOutputFile>>;
/** Only the pinned Wan artifact node (246) is admissible for this route. */
export function motionOutputFiles(graph:Record<string,{class_type:string}>,entry:HistoryEntry,artifactNode:string):OutputFile[]{
  const saves=Object.entries(graph).filter(([,node])=>node.class_type==="SaveVideo");
  if(saves.length!==1||saves[0][0]!==artifactNode)throw new Error("Pinned motion artifact node is unavailable");
  const file=firstOutputFile(entry.outputs[artifactNode]);
  return file?[file]:[];
}

/** A submitting motion run without a POST marker never reached ComfyUI. */
export function motionRecoveryAction(runState:string,row:MotionPreparationRow|undefined):"reset_to_pending"|"cancel_pre_post"|"none"{
  if(!row||row.postAttemptedAt)return "none";
  if(runState==="cancel_requested")return "cancel_pre_post";
  return runState==="submitting"&&row.state==="prepared"?"reset_to_pending":"none";
}

export function classifyMotionError(error:unknown):"permanent"|"retryable"{
  if(error instanceof MediaProbeUnavailableError)return "retryable";
  if(error instanceof HttpError)return error.statusCode===429||error.statusCode>=500?"retryable":"permanent";
  return "retryable";
}
function errorText(error:unknown,fallback:string):string{
  const message=error instanceof Error?error.message:"";
  return (message||fallback).slice(0,500);
}

export interface MotionLedgerStore{
  ensure(workspaceId:string,runId:string,source:MotionSourceIdentity):Promise<MotionPreparationRow>;
  get(workspaceId:string,runId:string):Promise<MotionPreparationRow|undefined>;
  runState(workspaceId:string,runId:string):Promise<string|undefined>;
  claim(workspaceId:string,runId:string,token:string,leaseExpiresAt:Date):Promise<MotionPreparationRow|undefined>;
  publishPrepared(workspaceId:string,runId:string,token:string,receipt:MotionMediaReceipt):Promise<"published"|"already"|"canceled"|"lost">;
  resetPending(workspaceId:string,runId:string,error:string,leaseToken?:string):Promise<void>;
  markFailed(workspaceId:string,runId:string,error:string,leaseToken?:string):Promise<boolean>;
  markCanceled(workspaceId:string,runId:string):Promise<void>;
  commitGraphAndMarkPost(workspaceId:string,runId:string,graph:ApiGraph,digest:string):Promise<"marked"|"already"|"canceled"|"not_prepared"|"digest_mismatch">;
  resetSubmittingToPending(workspaceId:string,runId:string):Promise<boolean>;
  finalizePrePostCancellation(workspaceId:string,runId:string):Promise<string|null|undefined>;
}

function mapRow(row:any):MotionPreparationRow{
  return {
    workspaceId:row.workspace_id,runId:row.run_id,state:row.state,normalizationVersion:Number(row.normalization_version),
    sourceAssetId:row.source_asset_id??null,sourceStorageKey:row.source_storage_key??null,
    sourceSha256:row.source_sha256??null,sourceBytes:row.source_bytes===null||row.source_bytes===undefined?null:Number(row.source_bytes),
    normalizedStorageKey:row.normalized_storage_key??null,normalizedSha256:row.normalized_sha256??null,
    normalizedBytes:row.normalized_bytes===null||row.normalized_bytes===undefined?null:Number(row.normalized_bytes),
    receipt:row.receipt??null,graphDigest:row.graph_digest??null,
    postAttemptedAt:row.post_attempted_at?new Date(row.post_attempted_at).toISOString():null,
    attempt:Number(row.attempt),leaseOwner:row.lease_owner??null,
    leaseExpiresAt:row.lease_expires_at?new Date(row.lease_expires_at).toISOString():null,error:row.error??null,
  };
}
const ledgerColumns="workspace_id,run_id,state,normalization_version,source_asset_id,source_storage_key,source_sha256,source_bytes,normalized_storage_key,normalized_sha256,normalized_bytes,receipt,graph_digest,post_attempted_at,attempt,lease_owner,lease_expires_at,error";

export class PgMotionLedgerStore implements MotionLedgerStore{
  constructor(private readonly pool:Pool){}
  async ensure(workspaceId:string,runId:string,source:MotionSourceIdentity):Promise<MotionPreparationRow>{
    await this.pool.query(
      "INSERT INTO motion_preparations(workspace_id,run_id,state,normalization_version,source_asset_id,source_storage_key,source_sha256,source_bytes) VALUES($1,$2,'pending',$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,run_id) DO NOTHING",
      [workspaceId,runId,MOTION_MEDIA_VERSION,source.assetId,source.storageKey,source.sha256,source.bytes]);
    const row=await this.get(workspaceId,runId);
    if(!row)throw new Error("Motion preparation record is unavailable");
    return row;
  }
  async get(workspaceId:string,runId:string):Promise<MotionPreparationRow|undefined>{
    const result=await this.pool.query(`SELECT ${ledgerColumns} FROM motion_preparations WHERE workspace_id=$1 AND run_id=$2`,[workspaceId,runId]);
    return result.rows[0]?mapRow(result.rows[0]):undefined;
  }
  async runState(workspaceId:string,runId:string):Promise<string|undefined>{
    const result=await this.pool.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2",[workspaceId,runId]);
    return result.rows[0]?.state as string|undefined;
  }
  async claim(workspaceId:string,runId:string,token:string,leaseExpiresAt:Date):Promise<MotionPreparationRow|undefined>{
    const result=await this.pool.query(
      `UPDATE motion_preparations SET state='preparing',lease_owner=$3,lease_expires_at=$4,attempt=attempt+1,error=NULL,updated_at=now()
       WHERE workspace_id=$1 AND run_id=$2 AND (state='pending' OR (state='preparing' AND lease_expires_at<now())) RETURNING ${ledgerColumns}`,
      [workspaceId,runId,token,leaseExpiresAt]);
    return result.rows[0]?mapRow(result.rows[0]):undefined;
  }
  async publishPrepared(workspaceId:string,runId:string,token:string,receipt:MotionMediaReceipt):Promise<"published"|"already"|"canceled"|"lost">{
    return transaction(this.pool,async client=>{
      const run=(await client.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,runId])).rows[0];
      if(!run||["canceled","cancel_requested","failed","succeeded"].includes(run.state))return "canceled" as const;
      if(run.state!=="pending")return "lost" as const;
      const current=(await client.query(`SELECT ${ledgerColumns} FROM motion_preparations WHERE workspace_id=$1 AND run_id=$2 FOR UPDATE`,[workspaceId,runId])).rows[0];
      if(!current)return "lost" as const;
      if(current.state==="prepared"||current.state==="submitted")return "already" as const;
      if(current.state!=="preparing"||current.lease_owner!==token)return "lost" as const;
      await client.query(
        `UPDATE motion_preparations SET state='prepared',normalization_version=$3,source_storage_key=$4,source_sha256=$5,source_bytes=$6,
         normalized_storage_key=$7,normalized_sha256=$8,normalized_bytes=$9,receipt=$10,lease_owner=NULL,lease_expires_at=NULL,error=NULL,updated_at=now()
         WHERE workspace_id=$1 AND run_id=$2`,
        [workspaceId,runId,receipt.normalizationVersion,receipt.sourceKey,receipt.sourceSha256,receipt.sourceBytes,
         receipt.normalizedKey,receipt.normalizedSha256,receipt.normalizedBytes,JSON.stringify(receipt)]);
      return "published" as const;
    });
  }
  async resetPending(workspaceId:string,runId:string,error:string,leaseToken?:string):Promise<void>{
    await this.pool.query(
      `UPDATE motion_preparations SET state='pending',normalized_storage_key=NULL,normalized_sha256=NULL,normalized_bytes=NULL,receipt=NULL,
       lease_owner=NULL,lease_expires_at=NULL,error=$3,updated_at=now()
       WHERE workspace_id=$1 AND run_id=$2 AND post_attempted_at IS NULL
       AND (($4::text IS NOT NULL AND state='preparing' AND lease_owner=$4)
         OR ($4::text IS NULL AND state IN ('pending','prepared') AND lease_owner IS NULL))`,
      [workspaceId,runId,error.slice(0,500),leaseToken??null]);
  }
  async markFailed(workspaceId:string,runId:string,error:string,leaseToken?:string):Promise<boolean>{
    const result=await this.pool.query(
      `UPDATE motion_preparations SET state='failed',lease_owner=NULL,lease_expires_at=NULL,error=$3,updated_at=now()
       WHERE workspace_id=$1 AND run_id=$2 AND post_attempted_at IS NULL
       AND (($4::text IS NOT NULL AND state='preparing' AND lease_owner=$4)
         OR ($4::text IS NULL AND state IN ('pending','prepared') AND lease_owner IS NULL))`,
      [workspaceId,runId,error.slice(0,500),leaseToken??null]);
    return !!result.rowCount;
  }
  async markCanceled(workspaceId:string,runId:string):Promise<void>{
    await this.pool.query(
      `UPDATE motion_preparations SET state='canceled',lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE workspace_id=$1 AND run_id=$2 AND state IN ('pending','preparing','prepared') AND post_attempted_at IS NULL`,
      [workspaceId,runId]);
  }
  async commitGraphAndMarkPost(workspaceId:string,runId:string,graph:ApiGraph,digest:string):Promise<"marked"|"already"|"canceled"|"not_prepared"|"digest_mismatch">{
    return transaction(this.pool,async client=>{
      const run=(await client.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,runId])).rows[0];
      if(!run||["canceled","cancel_requested"].includes(run.state))return "canceled" as const;
      if(run.state!=="submitting")return "not_prepared" as const;
      const current=(await client.query(`SELECT ${ledgerColumns} FROM motion_preparations WHERE workspace_id=$1 AND run_id=$2 FOR UPDATE`,[workspaceId,runId])).rows[0];
      if(!current)return "not_prepared" as const;
      if(current.post_attempted_at)return "already" as const;
      if(current.state!=="prepared")return "not_prepared" as const;
      if(current.graph_digest&&current.graph_digest!==digest)return "digest_mismatch" as const;
      await client.query("UPDATE runs SET graph=$1,updated_at=now() WHERE workspace_id=$2 AND id=$3",[JSON.stringify(graph),workspaceId,runId]);
      await client.query(
        "UPDATE motion_preparations SET state='submitted',graph_digest=$3,post_attempted_at=now(),updated_at=now() WHERE workspace_id=$1 AND run_id=$2",
        [workspaceId,runId,digest]);
      return "marked" as const;
    });
  }
  async resetSubmittingToPending(workspaceId:string,runId:string):Promise<boolean>{
    return transaction(this.pool,async client=>{
      const run=(await client.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,runId])).rows[0];
      const current=run?(await client.query(`SELECT ${ledgerColumns} FROM motion_preparations WHERE workspace_id=$1 AND run_id=$2 FOR UPDATE`,[workspaceId,runId])).rows[0]:undefined;
      if(!run||!current||motionRecoveryAction(run.state,mapRow(current))!=="reset_to_pending")return false;
      await client.query("UPDATE runs SET state='pending',error=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",[workspaceId,runId]);
      await client.query("INSERT INTO run_events(workspace_id,run_id,state,detail) VALUES($1,$2,'pending',$3)",[workspaceId,runId,JSON.stringify({motionRecovery:"pre_post_restart"})]);
      return true;
    });
  }
  async finalizePrePostCancellation(workspaceId:string,runId:string):Promise<string|null|undefined>{
    return transaction(this.pool,async client=>{
      const run=(await client.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,runId])).rows[0];
      const current=run?(await client.query(`SELECT ${ledgerColumns} FROM motion_preparations WHERE workspace_id=$1 AND run_id=$2 FOR UPDATE`,[workspaceId,runId])).rows[0]:undefined;
      if(!run||!current||motionRecoveryAction(run.state,mapRow(current))!=="cancel_pre_post")return undefined;
      await client.query("UPDATE runs SET state='canceled',error=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",[workspaceId,runId]);
      await client.query("UPDATE motion_preparations SET state='canceled',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE workspace_id=$1 AND run_id=$2",[workspaceId,runId]);
      await client.query("INSERT INTO run_events(workspace_id,run_id,state,detail) VALUES($1,$2,'canceled',$3)",[workspaceId,runId,JSON.stringify({motionRecovery:"pre_post_cancellation"})]);
      return current.normalized_storage_key??null;
    });
  }
}

export type MotionMediaDeps={
  normalize:(store:DiskStore,workspaceId:string,sourceKey:string,signal?:AbortSignal)=>Promise<MotionMediaReceipt>;
  verify:(target:{store:DiskStore;workspaceId:string;key:string},expected:MotionMediaReceipt|{width:number;height:number;decodedFrameCount:number;timingDigest:string},signal?:AbortSignal)=>Promise<MotionOutputVerification>;
  hashFile:(filename:string)=>Promise<string>;
};
export const defaultMotionMediaDeps:MotionMediaDeps={
  normalize:(store,workspaceId,sourceKey,signal)=>normalizeMotionInput(store,workspaceId,sourceKey,signal),
  verify:(target,expected,signal)=>verifyMotionOutput(target,expected,signal),
  hashFile:fileSha256,
};

export type PrepareMotionOutcome=
  |{kind:"prepared";receipt:MotionMediaReceipt}
  |{kind:"canceled"}
  |{kind:"busy"}
  |{kind:"retryable";error:string}
  |{kind:"failed";error:string}
  |{kind:"blocked_posted"};

function cancellationWatcher(ledger:MotionLedgerStore,workspaceId:string,runId:string,pollMs:number){
  const controller=new AbortController();
  let stopped=false;
  const timer=setInterval(()=>{
    if(stopped)return;
    void ledger.runState(workspaceId,runId).then(state=>{
      if(!stopped&&(state==="canceled"||state==="cancel_requested"))controller.abort(new Error("Motion preparation canceled"));
    }).catch(()=>{});
  },pollMs);
  timer.unref?.();
  return {signal:controller.signal,stop(){stopped=true;clearInterval(timer);}};
}

/**
 * Idempotent, restart-safe preparation state machine. Runs entirely while the
 * owning run is `pending`. A completed receipt is always reverified against
 * the stored normalized bytes before it may be compiled; invalid stored bytes
 * are removed and preparation repeats. Cancellation is honored before,
 * during (abort signal raced against run state) and immediately after media
 * work, and a canceled or losing candidate is never published.
 */
export async function prepareMotionRun(args:{
  ledger:MotionLedgerStore;store:DiskStore;workspaceId:string;runId:string;source:MotionSourceIdentity;
  deps?:MotionMediaDeps;leaseMs?:number;pollMs?:number;newToken?:()=>string;now?:()=>Date;
}):Promise<PrepareMotionOutcome>{
  const {ledger,store,workspaceId,runId,source}=args;
  const deps=args.deps??defaultMotionMediaDeps,leaseMs=args.leaseMs??MOTION_PREPARATION_LEASE_MS;
  const pollMs=args.pollMs??500,newToken=args.newToken??newId,now=args.now??(()=>new Date());
  const removeKey=async(key:string|null|undefined)=>{if(key)await store.remove(workspaceId,key).catch(()=>{});};
  const canceledNow=async()=>{const s=await ledger.runState(workspaceId,runId).catch(()=>undefined);return s==="canceled"||s==="cancel_requested";};

  let row=await ledger.ensure(workspaceId,runId,source);
  if((row.sourceAssetId&&row.sourceAssetId!==source.assetId)||(row.sourceStorageKey&&row.sourceStorageKey!==source.storageKey)
    ||(row.sourceSha256&&row.sourceSha256!==source.sha256)){
    const error="Motion source changed after the run was queued; upload it again";
    return await ledger.markFailed(workspaceId,runId,error)?{kind:"failed",error}:{kind:"busy"};
  }
  if(row.postAttemptedAt)return {kind:"blocked_posted"};
  if(row.state==="failed")return {kind:"failed",error:row.error??"Motion preparation failed"};
  if(row.state==="canceled")return {kind:"canceled"};
  const initialState=await ledger.runState(workspaceId,runId);
  if(initialState==="canceled"||initialState==="cancel_requested"){
    await ledger.markCanceled(workspaceId,runId);await removeKey(row.normalizedStorageKey);return {kind:"canceled"};
  }
  if(initialState!=="pending")return {kind:"busy"};

  // The frozen source bytes must still be the queued asset's bytes. Hashing
  // happens outside any transaction; a mismatch is permanent, like the other
  // validated-media execution paths.
  try{
    const sourceFile=await store.file(workspaceId,source.storageKey);
    if(await deps.hashFile(sourceFile)!==source.sha256)throw new Error("hash mismatch");
  }catch{
    if(await canceledNow()){await ledger.markCanceled(workspaceId,runId);return {kind:"canceled"};}
    const error="Motion source is missing or changed; upload it again";
    return await ledger.markFailed(workspaceId,runId,error)?{kind:"failed",error}:{kind:"busy"};
  }

  const revalidate=async(receipt:MotionMediaReceipt):Promise<"ok"|"invalid"|PrepareMotionOutcome>=>{
    if(receipt.workspaceId!==workspaceId||receipt.sourceKey!==source.storageKey||receipt.sourceSha256!==source.sha256){
      const error="Stored motion receipt no longer matches the queued source";
      return await ledger.markFailed(workspaceId,runId,error)?{kind:"failed",error}:{kind:"busy"};
    }
    const watcher=cancellationWatcher(ledger,workspaceId,runId,pollMs);
    try{
      await deps.verify({store,workspaceId,key:receipt.normalizedKey},receipt,watcher.signal);
    }catch(e){
      if(await canceledNow()){await ledger.markCanceled(workspaceId,runId);return {kind:"canceled"};}
      if(classifyMotionError(e)==="retryable")return {kind:"retryable",error:errorText(e,"Motion media verification is temporarily unavailable")};
      return "invalid";
    }finally{watcher.stop();}
    if(await canceledNow()){await ledger.markCanceled(workspaceId,runId);await removeKey(receipt.normalizedKey);return {kind:"canceled"};}
    return "ok";
  };

  for(let iteration=0;iteration<2;iteration++){
    row=await ledger.get(workspaceId,runId)??row;
    if(row.postAttemptedAt)return {kind:"blocked_posted"};
    if(row.state==="prepared"&&row.receipt){
      let receipt:MotionMediaReceipt;
      try{receipt=motionReceiptSchema.parse(row.receipt);}
      catch{await removeKey(row.normalizedStorageKey);await ledger.resetPending(workspaceId,runId,"Stored motion receipt is invalid");continue;}
      const verdict=await revalidate(receipt);
      if(verdict==="ok")return {kind:"prepared",receipt};
      if(verdict!=="invalid")return verdict;
      await removeKey(receipt.normalizedKey);
      await ledger.resetPending(workspaceId,runId,"Stored normalized motion media failed revalidation");
      continue;
    }
    if(row.state==="failed")return {kind:"failed",error:row.error??"Motion preparation failed"};
    if(row.state==="canceled")return {kind:"canceled"};

    const token=newToken();
    const claimed=await ledger.claim(workspaceId,runId,token,new Date(now().getTime()+leaseMs));
    if(!claimed){
      const current=await ledger.get(workspaceId,runId);
      if(current?.postAttemptedAt)return {kind:"blocked_posted"};
      if(current?.state==="prepared")continue;
      return {kind:"busy"};
    }
    const watcher=cancellationWatcher(ledger,workspaceId,runId,pollMs);
    let receipt:MotionMediaReceipt|undefined;
    try{
      receipt=motionReceiptSchema.parse(await deps.normalize(store,workspaceId,source.storageKey,watcher.signal));
      if(receipt.workspaceId!==workspaceId||receipt.sourceKey!==source.storageKey||receipt.sourceSha256!==source.sha256)
        throw new HttpError(422,"Motion source changed during normalization; upload it again");
      await deps.verify({store,workspaceId,key:receipt.normalizedKey},receipt,watcher.signal);
    }catch(e){
      watcher.stop();
      if(await canceledNow()){
        // normalizeMotionInput removes its own unpublished candidate on abort;
        // remove again defensively in case cancellation landed after it returned.
        await removeKey(receipt?.normalizedKey);await ledger.markCanceled(workspaceId,runId);return {kind:"canceled"};
      }
      const error=errorText(e,"Motion normalization failed");
      await removeKey(receipt?.normalizedKey);
      if(classifyMotionError(e)==="permanent")return await ledger.markFailed(workspaceId,runId,error,token)?{kind:"failed",error}:{kind:"busy"};
      await ledger.resetPending(workspaceId,runId,error,token);return {kind:"retryable",error};
    }
    watcher.stop();
    if(await canceledNow()){await removeKey(receipt.normalizedKey);await ledger.markCanceled(workspaceId,runId);return {kind:"canceled"};}
    const published=await ledger.publishPrepared(workspaceId,runId,token,receipt);
    if(published==="published"){
      if(await canceledNow()){
        // Cancellation won the race after publication but before submission:
        // the run is canceled, so withdraw the normalized bytes.
        await ledger.markCanceled(workspaceId,runId);await removeKey(receipt.normalizedKey);return {kind:"canceled"};
      }
      return {kind:"prepared",receipt};
    }
    if(published==="already"){
      const current=await ledger.get(workspaceId,runId);
      if(current?.normalizedStorageKey!==receipt.normalizedKey)await removeKey(receipt.normalizedKey);
      continue;
    }
    await removeKey(receipt.normalizedKey);
    if(published==="canceled"){await ledger.markCanceled(workspaceId,runId);return {kind:"canceled"};}
    return {kind:"busy"};
  }
  return {kind:"busy"};
}

/**
 * The single POST boundary: the durable marker (with graph and digest) is
 * committed first; `post` runs only when this call won the marker. Any later
 * call is blocked, so an ambiguous first POST can never become a second one.
 */
export async function postMotionPrompt<T>(
  ledger:MotionLedgerStore,workspaceId:string,runId:string,graph:ApiGraph,digest:string,post:()=>Promise<T>,
):Promise<{kind:"posted";value:T}|{kind:"blocked";reason:"already"|"canceled"|"not_prepared"|"digest_mismatch"}>{
  const mark=await ledger.commitGraphAndMarkPost(workspaceId,runId,graph,digest);
  if(mark!=="marked")return {kind:"blocked",reason:mark};
  return {kind:"posted",value:await post()};
}

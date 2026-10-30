import type { Pool,PoolClient } from "pg";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { WebSocket } from "ws";
import {jobFeedRoutes} from "./job-feed";
import sharp from "sharp";
import type { CapabilityBundle,Invocation } from "../src/capabilities/types";
import type { ApiGraph } from "../src/workflow/build";
import { compileLocal } from "../src/capabilities/compile";
import {compileScailChunks,planScailChunks,SCAIL_CHUNK_FRAMES,scailChunkParts} from "../src/capabilities/replace";
import {stageForNode} from "./develop";
import {chainKeyPrefix,chainPart,type JobPart} from "./progress";
import {compileJutsuRelay,planJutsuRelay} from "../src/capabilities/jutsu";
import {inspectReplaceClip} from "./replace-clip-check";
import {requestSchema,publicColumns,canonical,extension,prepareInvocation,enqueuePreparedRun,cancelRun} from "./run-submission";
import {sdkClient,sdkTransportConfigured,sdkSupportsManifest,cloudInputs,sdkFailureReason} from "./sdk-client";
import {measurePreservation} from "./edit-preservation";
import {comfyCloudKey,scailChunksEnabled} from "./config";
import {ComfyError} from "@comfyorg/sdk";
import type {Job,Output} from "@comfyorg/sdk";
import { firstOutputFile, type HistoryEntry, type RawQueueItem } from "../src/comfy/client";
import { probeGlb } from "./glb";
import { AudioToolUnavailableError, probeMedia } from "./audio-processing-validation";
import { member, HttpError } from "./auth";
import { transaction } from "./db";
import { hashToken, newId } from "./crypto";
import type { DiskStore } from "./storage";
import {hasRoomToStart,IdleUnloader,freeIdleWorkerForMemory,MIN_FREE_RAM_SHARE,ramNote} from "./memory-guard";
import { MediaProbeUnavailableError,probeVideo } from "./media";
import {BackgroundMaskValidationError,assertBackgroundMaskRegions,fileSha256,inspectMaskCoverage,sourceLinkedMaskSchema,validateMaskPair,verifyMaskedOutput} from "./masked-media";
import {EffectInputValidationError,verifyEffectInputs} from "./depth-video-admission";
import {AlignedMaskInputError,verifyAlignedMaskInputs} from "./aligned-mask-input";
import {verifyVoiceInput} from "./voice-input";
import {verifySceneReference} from "./scene-probe-admission";
import {verifyPosePreviewInputs,posePreviewOutputMetadata} from "./pose-preview-admission";
import {admissionSchema,enqueueDirect} from "./providers/submission";
import {isCloudRoute,prepareCloudInvocation,CLOUD_WORKER_REASON} from "./cloud-readiness";
import {productionDirectRegistry,type DirectRegistry} from "./providers/registry";
import {loadWorkspaceCatalogue} from "./workflow-imports";
import {planUpscale,upscaleBundle,upscaleControls} from "./chain-upscale";
import {maskedEditReadiness} from "./media-tools";
import {assertImageExtension,probeImage,type ImageMetadata} from "./image-media";
import {assertSafeImageFile,imageOutputFiles} from "./image-output";
import {
  PgMotionLedgerStore,compileMotionGraph,defaultMotionMediaDeps,expectedMotionOutput,graphDigest,
  motionContractFor,motionOutputFiles,motionRecoveryAction,postMotionPrompt,prepareMotionRun,
  type MotionContract,type MotionLedgerStore,type MotionMediaDeps,
} from "./motion-execution";
import {durableArtifactStorageKeys,exactImageArtifactSlotSpecs,planArtifactSlots,publishStagedArtifactBatch,recordStagedArtifactBatch,resolveDeclaredImageArtifacts,sanitizedImageProvenance,validatePngArtifactBatch,type PngArtifactPolicy,type StagedImageArtifact} from "./image-artifacts";
import type {ImageArtifactDeclarationV1,ImageArtifactsContractV1} from "../src/capabilities/image-artifacts";
import {PngValidationError} from "./image-artifacts-validation";
import {alignedImageInputSnapshotSchema} from "./image-input-admission";

const base="/api/v1/workspaces/:workspaceId";
const ws=z.object({workspaceId:z.uuid()}),item=ws.extend({id:z.uuid()});
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const trackingSnapshotSchema=z.object({
  validationVersion:z.literal(1),sourceAssetId:z.uuid(),sourceSha256:digest,projectId:z.uuid(),
  width:z.number().int(),height:z.number().int(),fps:z.literal(16),frames:z.number().int(),timingDigest:digest,
  trackingMode:z.enum(["points","prompt"]).optional(),
  frameIndex:z.literal(0).optional(),objectIndex:z.literal(1).optional(),
  points:z.array(z.object({x:z.number(),y:z.number(),kind:z.enum(["include","exclude"])}).strict()).min(1).max(32).optional(),
  prompt:z.string().trim().min(2).max(200).optional(),
  workflowId:z.string().min(1),workflowVersion:z.string().min(1),routeId:z.string().min(1),workflowRevisionId:z.uuid(),workflowSha256:digest,
  requiredCheckpoint:z.string().min(1),requiredCheckpointSha256:digest,
}).strict().superRefine((value,ctx)=>{
  const mode=value.trackingMode??(value.prompt?"prompt":"points");
  if(mode==="prompt"){
    if(!value.prompt)ctx.addIssue({code:"custom",path:["prompt"],message:"Prompt tracking requires a prompt"});
    if(value.points||value.frameIndex!==undefined||value.objectIndex!==undefined)ctx.addIssue({code:"custom",path:["prompt"],message:"Prompt tracking cannot carry points"});
  }else{
    if(!value.points)ctx.addIssue({code:"custom",path:["points"],message:"Point tracking requires points"});
    if(value.frameIndex!==0||value.objectIndex!==1)ctx.addIssue({code:"custom",path:["points"],message:"Points must be placed on frame zero for one object"});
    if(value.prompt)ctx.addIssue({code:"custom",path:["points"],message:"Point tracking cannot carry a prompt"});
  }
});

type OutputFile=NonNullable<ReturnType<typeof firstOutputFile>>;
/** An SDK submission with no job id is ended as failed after this long. */
const SDK_UNKNOWN_GIVE_UP_MS=24*60*60*1000;
/** A native run the worker reports in neither its queue nor its history for this long is over. */
const SUBMISSION_UNKNOWN_LIMIT_MS=15*60_000;
type OutputContract=NonNullable<CapabilityBundle["manifest"]["outputContract"]>;
const MAX_IMAGE_ARTIFACTS=4;
/** Initial submission plus two retries for transient preparation failures. */
const MAX_PRE_SUBMISSION_ATTEMPTS=3;
const transientPreparation=/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR|socket hang up|network|timeout|timed out|Worker upload failed .*\((?:5\d\d|429)\)/i;
function isTransientPreparationError(error:unknown){
  if(error instanceof EffectInputValidationError||error instanceof AlignedMaskInputError)return false;
  if(error instanceof HttpError&&error.statusCode>=400&&error.statusCode<500&&error.statusCode!==429)return false;
  if(error instanceof ComfyError&&(error.httpStatus??0)>=400&&(error.httpStatus??0)<500&&error.httpStatus!==429)return false;
  const name=error instanceof Error?error.name:"",message=error instanceof Error?error.message:String(error);
  return name==="TimeoutError"||name==="AbortError"||name==="TypeError"||transientPreparation.test(message);
}

/** A preparation failure should name what went wrong, not repeat the runtime's "fetch failed".
 *  Node keeps the useful part in `error.cause.code`, so read it and add the likely remedy. */
export function preparationFailureDetail(error:unknown):string{
  const base=error instanceof Error?error.message:String(error);
  if(error instanceof Error&&(error.name==="TimeoutError"||error.name==="AbortError"))return "the worker did not answer in time";
  const cause=(error as {cause?:{code?:string;message?:string}}|undefined)?.cause;
  const code=cause?.code??(typeof cause?.message==="string"?cause.message.match(/\b(E[A-Z]{3,})\b/)?.[1]:undefined);
  if(code||/fetch failed/i.test(base)){
    const remedy=code==="ECONNREFUSED"?" — the worker refused the connection, so ComfyUI is probably not running on that origin"
      :code==="ENOTFOUND"?" — the worker host name did not resolve"
      :code==="ETIMEDOUT"||code==="UND_ERR_CONNECT_TIMEOUT"?" — the connection timed out"
      :code==="ECONNRESET"?" — the worker closed the connection"
      :"";
    return `could not reach the worker${code?` (${code})`:""}${remedy}`;
  }
  return base;
}
/** ComfyUI puts the reason in status.messages as an `execution_error` entry. Without reading it a
 *  failed run can only say "execution failed", which tells the person nothing they can act on. */
export function workerFailureReason(entry:{status?:{messages?:unknown[]}}):string|undefined{
  const messages=entry?.status?.messages;
  if(!Array.isArray(messages))return undefined;
  for(const item of messages){
    if(!Array.isArray(item))continue;
    const [kind,data]=item as [string,Record<string,unknown>];
    if(kind!=="execution_error"||!data||typeof data!=="object")continue;
    const where=data.node_id!==undefined?` at node ${String(data.node_id)}${data.node_type?` (${String(data.node_type)})`:""}`:"";
    const detail=String(data.exception_message??data.exception_type??"").replace(/\s+/g," ").trim();
    if(!detail&&!where)continue;
    return `Worker failed${where}: ${detail||"no message from the worker"}`.slice(0,300);
  }
  return undefined;
}
/** The memory guard answers for the worker it was given: Comfy Cloud keeps its own memory. */
const workerKind=(worker:any):"local"|"cloud"=>worker?.kind==="cloud"?"cloud":"local";
function manifestMediaType(manifest:CapabilityBundle["manifest"]):"video"|"image"|"model3d"|"audio"{
  if(manifest.outputs.some(output=>output.required&&output.type==="model3d"))return "model3d";
  if(manifest.outputs.some(output=>output.required&&output.type==="audio"))return "audio";
  return manifest.outputs.some(output=>output.required&&output.type==="image")?"image":"video";
}

export function imageArtifactLimit(run:any,manifest:CapabilityBundle["manifest"]):number{
  const hasBatchControl=manifest.controls.some(control=>control.id==="batch_size");
  const declared=manifest.outputs.filter(port=>port.required&&port.type==="image").length;
  const requested=hasBatchControl?run.invocation?.controls?.batch_size:Math.max(1,declared);
  return typeof requested==="number"&&Number.isInteger(requested)&&requested>0?Math.min(requested,MAX_IMAGE_ARTIFACTS):1;
}

/** Resolve worker artifacts from the pinned contract. Source-linked masks have one
 * explicitly declared artifact; ordinary video workflows retain SaveVideo discovery. */
export function declaredOutputFiles(graph:Record<string,{class_type:string}>,entry:HistoryEntry,contract?:OutputContract,mediaType:"video"|"image"|"model3d"|"audio"="video"):OutputFile[]{
  if(contract){
    const node=graph[contract.artifactNode];
    if(!node||node.class_type!=="SaveVideo")throw new Error("Pinned mask artifact node is unavailable");
    const file=firstOutputFile(entry.outputs[contract.artifactNode]);
    return file?[file]:[];
  }
  if(mediaType==="image")return imageOutputFiles(graph,entry);
  if(mediaType==="audio")return Object.entries(graph).filter(([,node])=>/^SaveAudio/.test(node.class_type)).map(([id])=>firstOutputFile(entry.outputs[id])).filter((file):file is OutputFile=>!!file);
  if(mediaType==="model3d")return Object.entries(graph).filter(([,node])=>node.class_type==="SaveGLB").map(([id])=>firstOutputFile(entry.outputs[id])).filter((file):file is OutputFile=>!!file);
  return Object.entries(graph).filter(([,node])=>node.class_type==="SaveVideo").map(([id])=>firstOutputFile(entry.outputs[id])).filter((file):file is OutputFile=>!!file);
}

export function pendingMaskMetadata(sourceLinked:unknown){
  const receipt=sourceLinkedMaskSchema.parse(sourceLinked);
  return {sourceLinkedMask:receipt,maskReview:{version:1 as const,state:"pending" as const},generatedBy:{runId:receipt.producerRunId}};
}

export function publicOutputLineage(asset:any){
  const {metadata,storage_key,...lineage}=asset;
  const maskLineage=metadata?.sourceLinkedMask?{sourceLinkedMask:metadata.sourceLinkedMask,maskReview:metadata.maskReview,generatedBy:metadata.generatedBy}:undefined;
  const imageLineage=sanitizedImageProvenance(metadata);
  return {...lineage,...(maskLineage?{metadata:maskLineage}:Object.keys(imageLineage).length?{metadata:imageLineage}:{})};
}

function safeOutputFile(file:OutputFile):void{
  if(file.type!=="output"||!file.filename||/[\\/]|\.\./.test(file.filename)||/(^|[\\/])\.\.([\\/]|$)|^[\\/]|:/.test(file.subfolder))throw new Error("Invalid worker output path");
}
function boundedImageStream(body:ReadableStream<Uint8Array>,maxBytes:number):Readable{
  const chunks=async function*(){
    const reader=body.getReader();let bytes=0,complete=false;
    try{
      while(true){
        const next=await reader.read();
        if(next.done){complete=true;return;}
        bytes+=next.value.byteLength;
        if(bytes>maxBytes)throw new PermanentArtifactError("Worker image artifact exceeds its pinned byte limit");
        yield Buffer.from(next.value);
      }
    }finally{
      if(!complete)await reader.cancel().catch(()=>{});
      reader.releaseLock();
    }
  };
  return Readable.from(chunks());
}
export type DevelopFrame={preview:Buffer;contentType:"image/jpeg"|"image/png";value:number|null;max:number|null;node:string|null;seq:number;updatedAt:number};
const MAX_DEVELOP_PREVIEW_BYTES=4*1024*1024;
const MAX_SDK_OUTPUT_BYTES=64*1024*1024;
class PermanentArtifactError extends Error{}
export function permanentArtifactFailure(error:unknown):boolean{
  return !(error instanceof MediaProbeUnavailableError)&&(error instanceof PermanentArtifactError||error instanceof z.ZodError||error instanceof HttpError&&error.statusCode!==429&&error.statusCode<500);
}
/** "failed validation" alone tells nobody which field failed or what was expected. Keep the
 *  sentence, then append the reason the validator actually gave. */
export function validationFailureDetail(error:unknown):string|undefined{
  if(error instanceof z.ZodError){
    const issues=error.issues.slice(0,3).map(issue=>`${issue.path.join(".")||"(root)"}: ${issue.message}`.replace(/\s+/g," ").trim());
    return issues.length?issues.join("; ").slice(0,300):undefined;
  }
  if(error instanceof Error&&error.message&&!/failed validation/i.test(error.message))return error.message.replace(/\s+/g," ").trim().slice(0,300);
  return undefined;
}
function sdkFailure(job:Job):string{
  const error=job.error as {message?:unknown}|string|null|undefined;
  const message=typeof error==="string"?error:typeof error?.message==="string"?error.message:null;
  return message?`SDK proxy job failed: ${message.slice(0,300)}`:"SDK proxy job failed";
}

/** Comfy Cloud answers the same calls as a local ComfyUI but wants the key in a header on every one.
 *  A local worker sends no header at all, exactly as before; without a key nothing is sent, so the
 *  worker answers 401 instead of the request quietly looking anonymous. */
export function workerRequestHeaders(worker:{kind?:string|null},headers?:HeadersInit):HeadersInit|undefined{
  if(worker?.kind!=="cloud")return headers;
  const key=comfyCloudKey();
  if(!key)return headers;
  const merged=new Headers(headers);
  merged.set("X-API-Key",key);
  return merged;
}

/** Cloud keeps every input in one flat folder and the name we sent is what the graph loads, so a
 *  reported subfolder cannot move the file. A local ComfyUI honours that folder, so a non-empty one
 *  there still means the workflow would load the wrong path. */
export function acceptedUploadPath(worker:{kind?:string|null},filename:string,result:{name?:string;subfolder?:string}):boolean{
  if(result.name!==filename)return false;
  return worker?.kind==="cloud"||!result.subfolder;
}

const REPLACE_WINDOW_NODE="213:114";
/** Replace character renders a clip in 81-frame windows that each carry the last frames of the
 *  one before, so a long clip compiles into one chained pass per window. The local graph is
 *  compiled first, so every pass inherits the run's prompt, person and seed bindings.
 *  Chunking stays off until a real two-pass render passed the seam check: off, a long clip plans
 *  exactly one chunk and posts the same single 81-frame pass as before chunking existed. */
export function compileRunGraph(bundle:CapabilityBundle,invocation:Invocation,inputs:Record<string,string>,sourceFrames?:number):ApiGraph{
  const graph=compileLocal(bundle,{...invocation,inputs});
  const contract=bundle.manifest.replaceContract;
  if(!contract)return graph;
  if(sourceFrames===undefined)throw new Error("Replace character needs the source clip's frame count before it can compile");
  /* Local jutsu brings its own relay graph: the anchor, the relay windows and the composite are
     reviewed in the pack, so the clip's length only sets the window and crop lengths. The pack
     declares how many windows it has actually been run with. */
  if(contract.kind==="jutsu_relay_v1")return compileJutsuRelay(graph,planJutsuRelay(sourceFrames,contract.maxWindows??1));
  const plan=planScailChunks(sourceFrames);
  // A clip that fits one window is the reviewed graph as it stands: it already renders the clip's own length.
  if(plan.chunkCount===1||!scailChunksEnabled())return graph;
  // The template measures the window from the first 81 frames, which for a clip this long is exactly 81.
  // The chunked graph needs that number fixed so every pass takes the window the model was trained at.
  graph[REPLACE_WINDOW_NODE].inputs.length=SCAIL_CHUNK_FRAMES;
  return compileScailChunks(graph,plan);
}

export class ExecutionService {
  /** Reconcile a verified completed worker job after the old single-image import
   * limit rejected a declared multi-output workflow. Never resubmit generation. */
  async retryImagePublication(workspaceId:string,id:string){
    const run=(await this.pool.query("SELECT * FROM runs WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL",[workspaceId,id])).rows[0];
    if(!run)throw new HttpError(404,"Run not found");
    const revision=(await this.pool.query("SELECT manifest FROM workflow_revisions WHERE workspace_id=$1 AND id=$2",[workspaceId,run.workflow_revision_id])).rows[0];
    const manifest=revision?.manifest as CapabilityBundle["manifest"]|undefined;
    if(run.state!=="failed"||!/^Worker returned \d+ image artifacts; this run accepts at most \d+$/.test(run.error??"")||!run.remote_id||!run.graph||!manifest||manifest.imageArtifacts||run.transport==="sdk")throw new HttpError(409,"This run has no recoverable image publication");
    const worker=(await this.pool.query("SELECT * FROM workers WHERE workspace_id=$1 AND id=$2 AND enabled=true",[workspaceId,run.worker_id])).rows[0];
    if(!worker)throw new HttpError(409,"The original worker is unavailable");
    const response=await this.fetch(worker,`/history/${encodeURIComponent(run.remote_id)}`);
    if(!response.ok)throw new HttpError(503,"Completed worker history is unavailable");
    const entry=(await response.json() as Record<string,HistoryEntry>)[run.remote_id];
    if(entry?.status?.status_str!=="success"||canonical(entry.prompt?.[2])!==canonical(run.graph))throw new HttpError(409,"Completed worker graph does not match this run");
    const files=declaredOutputFiles(run.graph,entry,undefined,"image"),limit=imageArtifactLimit(run,manifest);
    if(files.length<1||files.length>limit)throw new HttpError(409,"Worker outputs exceed the declared image contract");
    return transaction(this.pool,async client=>{
      const current=(await client.query("SELECT state,remote_id FROM runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,id])).rows[0];
      if(current?.state!=="failed"||current.remote_id!==run.remote_id)throw new HttpError(409,"Run changed during publication recovery");
      await client.query("UPDATE runs SET state='queued',error=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",[workspaceId,id]);
      await client.query("INSERT INTO run_events(workspace_id,run_id,state,detail) VALUES($1,$2,'queued',$3)",[workspaceId,id,JSON.stringify({reason:"retry_image_publication",existingWorkerPrompt:run.remote_id,generationResubmitted:false})]);
      return {state:"queued",generationResubmitted:false};
    });
  }
  private inFlight:Promise<void>|null=null;
  private stopped=false;
  private readonly idle=new IdleUnloader();
  private readonly memoryWaiting=new Set<string>();
  private readonly memoryNotes=new Map<string,string>();
  /** Accepted runs the worker no longer lists anywhere; a second miss in a row ends them as lost. */
  private readonly missingOnWorker=new Set<string>();
  private readonly motionLedger:MotionLedgerStore;
  private readonly motionDeps:MotionMediaDeps;
  /** Latest real preview frame per run. Memory only: never persisted or replayed after restart. */
  private readonly develop=new Map<string,DevelopFrame>();
  private readonly developSockets=new Map<string,WebSocket>();
  /** At most eight failed/cancelled previews (32 MiB maximum); no timer or disk persistence. */
  private readonly terminalDevelop=new Set<string>();
  private readonly memoryReliefAttempted=new Set<string>();
  waitingForMemory(id:string){return this.memoryWaiting.has(id);}
  memoryNote(id:string){return this.memoryNotes.get(id);}
  clearMemoryWait(id:string){this.memoryWaiting.delete(id);this.memoryNotes.delete(id);}
  constructor(readonly pool:Pool,readonly store:DiskStore,readonly catalogue:CapabilityBundle[],motion?:{ledger?:MotionLedgerStore;deps?:MotionMediaDeps}){
    this.motionLedger=motion?.ledger??new PgMotionLedgerStore(pool);
    this.motionDeps=motion?.deps??defaultMotionMediaDeps;
  }
  developFrame(id:string):DevelopFrame|undefined{return this.develop.get(id);}
  private clearDevelop(id:string,retain=false):void{
    const socket=this.developSockets.get(id);
    this.developSockets.delete(id);
    socket?.close();
    if(retain&&this.develop.has(id)){
      this.terminalDevelop.delete(id);
      this.terminalDevelop.add(id);
      while(this.terminalDevelop.size>8){
        const oldest=this.terminalDevelop.values().next().value!;
        this.terminalDevelop.delete(oldest);this.develop.delete(oldest);
      }
    }else{this.terminalDevelop.delete(id);this.develop.delete(id);}
  }
  private watchDevelop(run:any,worker:any):void{
    // SDK jobs are submitted by the local proxy with its own client id; the app
    // cannot attach the native run preview socket reliably, so those runs keep
    // the honest skeleton/no-preview state instead of a guessed socket.
    if(run.transport==="sdk"||this.developSockets.has(run.id)||["succeeded","failed","canceled"].includes(run.state))return;
    let url:string;
    try{
      const origin=new URL(worker.origin);
      origin.protocol=origin.protocol==="https:"?"wss:":"ws:";
      url=`${origin.origin}${worker.api_prefix}${origin.pathname.replace(/\/$/,"")}/ws?clientId=${encodeURIComponent(run.id)}`;
    }catch{return;}
    let socket:WebSocket;
    try{socket=new WebSocket(url);}catch{return;}
    this.developSockets.set(run.id,socket);
    const current=()=>this.developSockets.get(run.id)===socket;
    socket.on("message",(raw:any,isBinary:boolean)=>{
      if(!current())return;
      if(!isBinary){
        let message:any;
        try{message=JSON.parse(raw.toString());}catch{return;}
        if(message?.type!=="progress")return;
        const data=message.data??{};
        if(typeof data.prompt_id==="string"&&run.remote_id&&data.prompt_id!==run.remote_id)return;
        const value=typeof data.value==="number"?data.value:null,max=typeof data.max==="number"?data.max:null,node=typeof data.node==="string"?data.node:null;
        const prior=this.develop.get(run.id);
        this.develop.set(run.id,prior?{...prior,value,max,node,updatedAt:Date.now()}:{preview:Buffer.alloc(0),contentType:"image/jpeg",value,max,node,seq:0,updatedAt:Date.now()});
        return;
      }
      const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(raw as ArrayBuffer);
      if(bytes.length<8||bytes.length>MAX_DEVELOP_PREVIEW_BYTES)return;
      const event=bytes.readUInt32BE(0),format=bytes.readUInt32BE(4);
      if(event!==1||(format!==1&&format!==2))return;
      const prior=this.develop.get(run.id);
      this.develop.set(run.id,{
        preview:Buffer.from(bytes.subarray(8)),
        contentType:format===2?"image/png":"image/jpeg",
        value:prior?.value??null,max:prior?.max??null,node:prior?.node??null,
        seq:(prior?.seq??0)+1,updatedAt:Date.now(),
      });
    });
    socket.on("close",()=>{if(current())this.developSockets.delete(run.id);});
    socket.on("error",()=>{if(current())this.developSockets.delete(run.id);});
  }
  async event(workspaceId:string,id:string,state:string,detail:Record<string,unknown>={}) {
    await this.pool.query("INSERT INTO run_events(workspace_id,run_id,state,detail) VALUES($1,$2,$3,$4)",[workspaceId,id,state,JSON.stringify(detail)]);
  }
  /** Requeue only a pre-submission failure that can plausibly succeed on a later attempt. */
  private async retryPreparation(run:any,message:string,detail:Record<string,unknown>={}):Promise<"retry"|"terminal"|"stopped">{
    return transaction(this.pool,async client=>{
      const attempts=Number((await client.query("SELECT count(*)::int AS attempts FROM run_events WHERE workspace_id=$1 AND run_id=$2 AND state='submitting'",[run.workspace_id,run.id])).rows[0]?.attempts??0);
      if(attempts>=MAX_PRE_SUBMISSION_ATTEMPTS)return "terminal";
      const moved=await client.query("UPDATE runs SET state='pending',error=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state='submitting' RETURNING id",[run.workspace_id,run.id,`Transient submission preparation failed; retrying (${attempts}/${MAX_PRE_SUBMISSION_ATTEMPTS-1}).`]);
      if(!moved.rowCount)return "stopped";
      await client.query("INSERT INTO run_events(workspace_id,run_id,state,detail) VALUES($1,$2,$3,$4)",[run.workspace_id,run.id,"retry_scheduled",JSON.stringify({attempt:attempts,nextAttempt:attempts+1,error:message,...detail})]);
      return "retry";
    });
  }
  private async publicationGate(client:PoolClient,run:any):Promise<"publish"|"published"|"canceled">{
    const current=(await client.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[run.workspace_id,run.id])).rows[0];
    if(!current)throw new PermanentArtifactError("Run is unavailable");
    if(current.state==="succeeded")return "published";
    if(current.state==="canceled")return "canceled";
    if(current.state==="cancel_requested"){
      await client.query("UPDATE runs SET state='canceled',error=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.id]);
      await client.query("INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,'canceled')",[run.workspace_id,run.id]);
      return "canceled";
    }
    if(!["submission_unknown","queued","running"].includes(current.state))throw new PermanentArtifactError("Run is no longer eligible to publish an artifact");
    return "publish";
  }
  private async cancelImportIfRequested(run:any):Promise<boolean>{
    return transaction(this.pool,async client=>(await this.publicationGate(client,run))==="canceled");
  }
  tick():Promise<void> {
    if(this.stopped)return Promise.resolve();
    if(this.inFlight)return this.inFlight;
    this.inFlight=this.reconcileAll().finally(()=>{this.inFlight=null;});
    return this.inFlight;
  }
  async close():Promise<void> {
    this.stopped=true;await this.inFlight;
    for(const socket of this.developSockets.values())socket.close();
    this.developSockets.clear();this.develop.clear();this.terminalDevelop.clear();this.memoryWaiting.clear();this.memoryNotes.clear();this.memoryReliefAttempted.clear();
  }
  private async reconcileAll():Promise<void> {
      const workers=(await this.pool.query("SELECT DISTINCT w.* FROM workers w JOIN runs r ON r.workspace_id=w.workspace_id AND r.worker_id=w.id WHERE r.state IN ('pending','submitting','submission_unknown','queued','running','cancel_requested') AND w.enabled=true")).rows;
      for(const worker of workers) {
        const lock=await this.pool.connect();
        try {
          const acquired=(await lock.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",[`worker:${worker.id}`])).rows[0].acquired;
          if(!acquired)continue;
          try {
            const runs=(await this.pool.query("SELECT * FROM runs WHERE workspace_id=$1 AND worker_id=$2 AND state IN ('pending','submitting','submission_unknown','queued','running','cancel_requested') ORDER BY created_at",[worker.workspace_id,worker.id])).rows;
            for(const run of runs) {
              try {
                this.watchDevelop(run,worker);
                if(run.state==="pending"){
                  const call=(path:string,init?:RequestInit)=>this.fetch(worker,path,init);
                  let room=await hasRoomToStart(call,undefined,workerKind(worker));
                  if(!room&&!this.memoryReliefAttempted.has(worker.id)){
                    const result=await freeIdleWorkerForMemory(call,workerKind(worker));
                    if(result!=="busy")this.memoryReliefAttempted.add(worker.id);
                    if(result==="freed")room=await hasRoomToStart(call,undefined,workerKind(worker));
                  }
                  if(!room){
                    const note=await ramNote(call,workerKind(worker));if(note)this.memoryNotes.set(run.id,note);
                    if(!this.memoryWaiting.has(run.id)){this.memoryWaiting.add(run.id);await this.event(run.workspace_id,run.id,"pending",{waiting:"memory",detail:`Waiting for free memory (below ${Math.round(MIN_FREE_RAM_SHARE*100)} %)`}).catch(()=>{});}
                    continue;
                  }
                  this.memoryWaiting.delete(run.id);this.memoryNotes.delete(run.id);
                  this.memoryReliefAttempted.delete(worker.id);
                  await this.submit(run,worker);
                } else await this.reconcile(run,worker);
              }
              catch { /* Offline workers retain durable state for the next reconciliation. */ }
            }
          } finally { await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[`worker:${worker.id}`]); }
        } finally { lock.release(); }
      }
      await this.unloadIdleModels();
  }
  private lastIdleCheck=0;
  /** Every 30 s: workers with an empty queue for 5 minutes get their models unloaded through ComfyUI's /free. */
  private async unloadIdleModels():Promise<void>{
    if(Date.now()-this.lastIdleCheck<30_000)return;
    this.lastIdleCheck=Date.now();
    const all=(await this.pool.query("SELECT w.*, EXISTS(SELECT 1 FROM runs r WHERE r.workspace_id=w.workspace_id AND r.worker_id=w.id AND r.state IN ('pending','submitting','submission_unknown','queued','running','cancel_requested')) AS has_runs FROM workers w WHERE w.enabled=true")).rows;
    for(const worker of all){
      try{await this.idle.check(worker.id,(path,init)=>this.fetch(worker,path,init),worker.has_runs,workerKind(worker));}catch{/* offline worker: nothing to unload */}
    }
  }
  private async fetch(worker:any,path:string,init:RequestInit={}) {
    const headers=workerRequestHeaders(worker,init.headers);
    return fetch(`${worker.origin}${worker.api_prefix}${path}`,{...init,...(headers?{headers}:{}),redirect:"error",signal:AbortSignal.timeout(20000)});
  }
  /** Upload one input file and keep the name the graph already refers to. */
  private async uploadInput(worker:any,filename:string,data:Blob,role:string):Promise<string>{
    const form=new FormData();form.append("image",data,filename);form.append("overwrite","false");
    const uploaded=await this.fetch(worker,"/upload/image",{method:"POST",body:form});
    if(!uploaded.ok)throw new Error(`Worker upload failed for ${role} (${uploaded.status}): ${(await uploaded.text()).slice(0,240)}`);
    if(!acceptedUploadPath(worker,filename,await uploaded.json() as {name?:string;subfolder?:string}))throw new Error("Worker returned an unexpected upload path");
    return filename;
  }
  private async uploadInputs(run:any,worker:any,assets:any[],motion?:{role:string;storageKey:string;filename:string}):Promise<Record<string,string>>{
    const inputs:Record<string,string>={};
    for(const asset of assets){
      const isMotion=motion?.role===asset.role;
      const filename=isMotion?motion!.filename:`comfyfield-${run.id}-${asset.id}.${extension(asset.content_type)}`;
      if(Object.values(inputs).includes(filename)){inputs[asset.role]=filename;continue;}
      const data=await openAsBlob(await this.store.file(run.workspace_id,isMotion?motion!.storageKey:asset.storage_key),{type:isMotion?"video/mp4":asset.content_type});
      inputs[asset.role]=await this.uploadInput(worker,filename,data,asset.role);
    }
    return inputs;
  }
  private async submitMotion(run:any,worker:any,pinned:any,contract:MotionContract){
    const bundle={manifest:pinned.manifest,template:pinned.graph} as CapabilityBundle;
    if(!bundle.template||bundle.manifest.version!==run.capability_version){await this.finish(run,"failed","Capability revision unavailable");return;}
    const assets=(await this.pool.query("SELECT a.*,r.role FROM run_inputs r JOIN assets a ON a.workspace_id=r.workspace_id AND a.id=r.asset_id WHERE r.workspace_id=$1 AND r.run_id=$2",[run.workspace_id,run.id])).rows;
    const sourceAsset=assets.find((asset:any)=>asset.role===contract.motionInput);
    if(!sourceAsset||sourceAsset.project_id!==run.project_id||!sourceAsset.storage_key){await this.finish(run,"failed","Motion source video is unavailable");return;}
    const prepared=await prepareMotionRun({ledger:this.motionLedger,store:this.store,workspaceId:run.workspace_id,runId:run.id,deps:this.motionDeps,
      source:{assetId:sourceAsset.id,storageKey:sourceAsset.storage_key,sha256:sourceAsset.sha256,bytes:Number(sourceAsset.bytes)}});
    if(prepared.kind==="canceled"||prepared.kind==="busy"||prepared.kind==="retryable")return;
    if(prepared.kind==="failed"){await this.finish(run,"failed",prepared.error);return;}
    if(prepared.kind==="blocked_posted"){
      const moved=await this.pool.query("UPDATE runs SET state='submission_unknown',error='Submission outcome is being reconciled; it will not be automatically resubmitted',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state='pending' RETURNING id",[run.workspace_id,run.id]);
      if(moved.rowCount)await this.event(run.workspace_id,run.id,"submission_unknown");
      return;
    }
    const receipt=prepared.receipt;
    const claimed=await this.pool.query("UPDATE runs SET state='submitting',updated_at=now() WHERE id=$1 AND workspace_id=$2 AND state='pending' RETURNING id",[run.id,run.workspace_id]);
    if(!claimed.rowCount){
      const current=(await this.pool.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.id])).rows[0]?.state;
      if(current==="canceled"){await this.motionLedger.markCanceled(run.workspace_id,run.id).catch(()=>{});await this.store.remove(run.workspace_id,receipt.normalizedKey).catch(()=>{});}
      return;
    }
    await this.event(run.workspace_id,run.id,"submitting");
    let remoteAttempted=false;
    try{
      const inputs=await this.uploadInputs(run,worker,assets,{role:contract.motionInput,storageKey:receipt.normalizedKey,filename:`comfyfield-${run.id}-motion.mp4`});
      const current=(await this.pool.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.id])).rows[0];
      if(current.state==="cancel_requested"){await this.finish(run,"canceled");return;}
      const {graph,digest}=compileMotionGraph(bundle,run.invocation,inputs,receipt);
      const posted=await postMotionPrompt(this.motionLedger,run.workspace_id,run.id,graph,digest,async()=>{
        remoteAttempted=true;
        return this.fetch(worker,"/prompt",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:graph,client_id:run.id,extra_data:{preview_method:"latent2rgb",comfyfield:{runId:run.id,workspaceId:run.workspace_id}}})});
      });
      if(posted.kind==="blocked"){
        if(posted.reason==="canceled"){await this.finish(run,"canceled");return;}
        if(posted.reason==="already"){remoteAttempted=true;throw new Error("Submission outcome unknown");}
        await this.finish(run,"failed","Motion submission could not be prepared");return;
      }
      const response=posted.value;
      if(response.status===400){await this.finish(run,"failed","Worker rejected the workflow inputs");return;}
      const result=await response.json() as {prompt_id?:string};
      if(!response.ok||!result.prompt_id)throw new Error("Submission outcome unknown");
      await this.pool.query("UPDATE runs SET remote_id=$1,state=CASE WHEN state='cancel_requested' THEN state ELSE 'queued' END,updated_at=now() WHERE workspace_id=$2 AND id=$3",[result.prompt_id,run.workspace_id,run.id]);
      await this.event(run.workspace_id,run.id,"queued");
    }catch(error){
      if(remoteAttempted){
        await this.pool.query("UPDATE runs SET state=CASE WHEN state='cancel_requested' THEN state ELSE 'submission_unknown' END,error='Submission outcome is being reconciled; it will not be automatically resubmitted',updated_at=now() WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.id]);
        await this.event(run.workspace_id,run.id,"submission_unknown");
      }else{
        const message=`Workflow preparation or media upload failed before submission: ${preparationFailureDetail(error)}`;
        if(isTransientPreparationError(error)&&await this.retryPreparation(run,message)==="retry")return;
        await this.finish(run,"failed",message);
      }
    }
  }
  /** Replace character splits the source clip into 81-frame passes, so that run needs the clip's
   *  frame count before it compiles. Every other capability compiles without reading the clip. */
  private async replaceSourceFrames(run:any,assets:any[],manifest:CapabilityBundle["manifest"]):Promise<number|undefined>{
    const contract=manifest.replaceContract;
    if(!contract)return undefined;
    const source=assets.find(asset=>asset.role===contract.sourceInput);
    if(!source?.storage_key||source.project_id!==run.project_id)throw new Error("Replace character source video is unavailable");
    return (await inspectReplaceClip(await this.store.file(run.workspace_id,source.storage_key))).frames;
  }
  private async submit(run:any,worker:any) {
    const pinnedPeek=(await this.pool.query("SELECT id,sha256,manifest,graph FROM workflow_revisions WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.workflow_revision_id])).rows[0];
    const motion=pinnedPeek?motionContractFor(pinnedPeek.manifest as CapabilityBundle["manifest"]):undefined;
    if(motion){await this.submitMotion(run,worker,pinnedPeek,motion);return;}
    const manifest=pinnedPeek?.manifest as CapabilityBundle["manifest"]|undefined;
    if(pinnedPeek&&manifest&&sdkTransportConfigured(worker)&&sdkSupportsManifest(manifest)){await this.submitSdk(run,worker);return;}
    const claimed=await this.pool.query("UPDATE runs SET state='submitting',updated_at=now() WHERE id=$1 AND workspace_id=$2 AND state='pending' RETURNING id",[run.id,run.workspace_id]);
    if(!claimed.rowCount)return;
    await this.event(run.workspace_id,run.id,"submitting");
    let remoteAttempted=false;
    try {
      const pinned=(await this.pool.query("SELECT id,sha256,manifest,graph FROM workflow_revisions WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.workflow_revision_id])).rows[0];
      const bundle=pinned?{manifest:pinned.manifest,template:pinned.graph} as CapabilityBundle:undefined;
      if(!bundle||bundle.manifest.version!==run.capability_version)throw new Error("Capability revision unavailable");
      const inputs:Record<string,string>={};
      const assets=(await this.pool.query("SELECT a.*,r.role FROM run_inputs r JOIN assets a ON a.workspace_id=r.workspace_id AND a.id=r.asset_id WHERE r.workspace_id=$1 AND r.run_id=$2",[run.workspace_id,run.id])).rows;
      await verifyEffectInputs(bundle.manifest.id,run.invocation,assets,run.project_id,key=>this.store.file(run.workspace_id,key));
      await verifyVoiceInput(bundle.manifest,run.invocation,assets,run.project_id,key=>this.store.file(run.workspace_id,key));
      await verifySceneReference(bundle.manifest.id,run.invocation,assets,key=>this.store.file(run.workspace_id,key));
      await verifyPosePreviewInputs(this.pool,bundle.manifest,run.invocation,assets,run.workspace_id,run.project_id,key=>this.store.file(run.workspace_id,key));
      await verifyAlignedMaskInputs(bundle.manifest,run.invocation,assets,run.project_id,key=>this.store.file(run.workspace_id,key));
      if(run.invocation.trackingSnapshot){
        const snapshot=trackingSnapshotSchema.parse(run.invocation.trackingSnapshot);
        const contract=bundle.manifest.outputContract;
        const requirement=contract&&bundle.manifest.routes.find(route=>route.id===run.route_id)?.requirements.find(item=>item.id===contract.checkpointRequirementId&&item.kind==="model");
        const checkpointSha256=requirement?.version?.match(/^sha256:([a-f0-9]{64})$/)?.[1];
        const source=contract&&assets.find(asset=>asset.role===contract.sourceInput);
        if(!contract||!requirement||!checkpointSha256||snapshot.workflowId!==bundle.manifest.id||snapshot.workflowVersion!==bundle.manifest.version||snapshot.routeId!==run.route_id||snapshot.workflowRevisionId!==pinned.id||snapshot.workflowSha256!==pinned.sha256||snapshot.requiredCheckpoint!==requirement.name||snapshot.requiredCheckpointSha256!==checkpointSha256||snapshot.sourceAssetId!==source?.id||snapshot.sourceSha256!==source?.sha256||snapshot.projectId!==run.project_id||source?.project_id!==run.project_id||await fileSha256(await this.store.file(run.workspace_id,source.storage_key))!==snapshot.sourceSha256)throw new Error("Tracked source or pinned workflow changed before execution");
      }
      if(bundle.manifest.imageInputContract){
        const contract=bundle.manifest.imageInputContract;
        const snapshot=alignedImageInputSnapshotSchema.parse(run.invocation.imageInputSnapshot);
        if(snapshot.dimensionMultiple!==contract.dimensionMultiple||snapshot.semantics!==contract.semantics)throw new Error("Aligned image admission receipt changed before execution");
        for(const [role,assetId,hash] of [[contract.sourceInput,snapshot.sourceAssetId,snapshot.sourceSha256],[contract.maskInput,snapshot.maskAssetId,snapshot.maskSha256]]){
          const asset=assets.find(a=>a.role===role);
          if(!asset||asset.id!==assetId||asset.sha256!==hash||await fileSha256(await this.store.file(run.workspace_id,asset.storage_key))!==hash)throw new Error("Validated image inputs changed before execution");
        }
      }
      const sourceFrames=await this.replaceSourceFrames(run,assets,bundle.manifest);
      for(const asset of assets) {
        const filename=`comfyfield-${run.id}-${asset.id}.${extension(asset.content_type)}`;
        if(Object.values(inputs).includes(filename)){inputs[asset.role]=filename;continue;}
        const data=await openAsBlob(await this.store.file(run.workspace_id,asset.storage_key),{type:asset.content_type});
        inputs[asset.role]=await this.uploadInput(worker,filename,data,asset.role);
      }
      const graph=compileRunGraph(bundle,run.invocation,inputs,sourceFrames);
      // A cancellation before prompt submission can complete without touching the worker queue.
      const current=(await this.pool.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.id])).rows[0];
      if(current.state==="cancel_requested") { await this.finish(run,"canceled");return; }
      await this.pool.query("UPDATE runs SET graph=$1,updated_at=now() WHERE workspace_id=$2 AND id=$3",[JSON.stringify(graph),run.workspace_id,run.id]);
      remoteAttempted=true;
      const response=await this.fetch(worker,"/prompt",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:graph,client_id:run.id,extra_data:{preview_method:"latent2rgb",comfyfield:{runId:run.id,workspaceId:run.workspace_id}}})});
      if(response.status===400) { await this.finish(run,"failed","Worker rejected the workflow inputs");return; }
      const result=await response.json() as {prompt_id?:string};
      if(!response.ok||!result.prompt_id)throw new Error("Submission outcome unknown");
      await this.pool.query("UPDATE runs SET remote_id=$1,state=CASE WHEN state='cancel_requested' THEN state ELSE 'queued' END,updated_at=now() WHERE workspace_id=$2 AND id=$3",[result.prompt_id,run.workspace_id,run.id]);
      await this.event(run.workspace_id,run.id,"queued");
    } catch(error) {
      if(remoteAttempted) {
        await this.pool.query("UPDATE runs SET state=CASE WHEN state='cancel_requested' THEN state ELSE 'submission_unknown' END,error='Submission outcome is being reconciled; it will not be automatically resubmitted',updated_at=now() WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.id]);
        await this.event(run.workspace_id,run.id,"submission_unknown");
      } else {
        const message=error instanceof EffectInputValidationError||error instanceof AlignedMaskInputError||manifest?.posePreviewContract&&error instanceof HttpError&&error.statusCode===422?error.message:`Workflow preparation or media upload failed before submission: ${preparationFailureDetail(error)}`;
        if(isTransientPreparationError(error)&&await this.retryPreparation(run,message)==="retry")return;
        await this.finish(run,"failed",message);
      }
    }
  }
  /**
   * Ordinary image and video runs go through the local Comfy API v2 proxy with the official
   * SDK. The ledger, run events, artifacts and UI stay the same; only the
   * submission and polling transport differ. The proxy job id is the external
   * id stored in runs.remote_id.
   */
  private async submitSdk(run:any,worker:any){
    const claimed=await this.pool.query("UPDATE runs SET state='submitting',transport='sdk',updated_at=now() WHERE id=$1 AND workspace_id=$2 AND state='pending' RETURNING id",[run.id,run.workspace_id]);
    if(!claimed.rowCount)return;
    await this.event(run.workspace_id,run.id,"submitting");
    let remoteAttempted=false;
    try {
      const pinned=(await this.pool.query("SELECT id,sha256,manifest,graph FROM workflow_revisions WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.workflow_revision_id])).rows[0];
      const bundle=pinned?{manifest:pinned.manifest,template:pinned.graph} as CapabilityBundle:undefined;
      if(!bundle||bundle.manifest.version!==run.capability_version)throw new Error("Capability revision unavailable");
      const assets=(await this.pool.query("SELECT a.*,r.role FROM run_inputs r JOIN assets a ON a.workspace_id=r.workspace_id AND a.id=r.asset_id WHERE r.workspace_id=$1 AND r.run_id=$2",[run.workspace_id,run.id])).rows;
      // The proxy forwards to the same ComfyUI instance. Uploading through the
      // native endpoint keeps the existing input validation and ComfyUI names.
      await verifyEffectInputs(bundle.manifest.id,run.invocation,assets,run.project_id,key=>this.store.file(run.workspace_id,key));
      await verifyVoiceInput(bundle.manifest,run.invocation,assets,run.project_id,key=>this.store.file(run.workspace_id,key));
      await verifySceneReference(bundle.manifest.id,run.invocation,assets,key=>this.store.file(run.workspace_id,key));
      await verifyPosePreviewInputs(this.pool,bundle.manifest,run.invocation,assets,run.workspace_id,run.project_id,key=>this.store.file(run.workspace_id,key));
      await verifyAlignedMaskInputs(bundle.manifest,run.invocation,assets,run.project_id,key=>this.store.file(run.workspace_id,key));
      const sourceFrames=await this.replaceSourceFrames(run,assets,bundle.manifest);
      /* Comfy Cloud has no ComfyUI input folder, so a cloud run's inputs become Cloud assets and
         the loader fields carry their references. The graph compiles first, because compileLocal
         only accepts the names the server made, and the stored graph keeps those names. */
      const cloud=worker.kind==="cloud";
      const named=Object.fromEntries(assets.map(asset=>[asset.role,`comfyfield-${run.id}-${asset.id}.${extension(asset.content_type)}`]));
      const inputs=cloud?named:await this.uploadInputs(run,worker,assets);
      const graph=compileRunGraph(bundle,run.invocation,inputs,sourceFrames);
      const current=(await this.pool.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.id])).rows[0];
      if(current.state==="cancel_requested"){await this.finish(run,"canceled");return;}
      await this.pool.query("UPDATE runs SET graph=$1,updated_at=now() WHERE workspace_id=$2 AND id=$3",[JSON.stringify(graph),run.workspace_id,run.id]);
      const client=sdkClient(worker);
      if(cloud)await cloudInputs(client,bundle.manifest,graph,await Promise.all(assets.map(async asset=>({role:asset.role,filename:`comfyfield-${run.id}-${asset.id}.${extension(asset.content_type)}`,contentType:asset.content_type,path:await this.store.file(run.workspace_id,asset.storage_key)}))));
      // Only the submit itself counts as a request: an upload that failed above made no job.
      remoteAttempted=true;
      const job=await client.submit(client.workflows.fromJson(graph as any),{
        // The local proxy accepts only an opaque string metadata label. The
        // ledger remains authoritative; no workflow metadata is required.
        idempotencyKey:run.idempotency_key,
      });
      await this.pool.query("UPDATE runs SET remote_id=$1,state=CASE WHEN state='cancel_requested' THEN state ELSE 'queued' END,updated_at=now() WHERE workspace_id=$2 AND id=$3",[job.id,run.workspace_id,run.id]);
      await this.event(run.workspace_id,run.id,"queued",{transport:"sdk",remoteId:job.id});
    } catch(error) {
      const status=error instanceof ComfyError?error.httpStatus:undefined;
      if(remoteAttempted&&status!==undefined&&status>=400&&status<500&&status!==429){
        // The proxy answered and rejected the request: no job was accepted, so
        // this is a definite failure rather than an unknown submission. The
        // cloud's own sentence says why; a bare 403 would read as a bad graph.
        console.error(`[runs] ${run.id}: SDK submit was rejected: ${sdkFailureReason(error)}`);
        await this.finish(run,"failed",`SDK proxy rejected the workflow inputs: ${sdkFailureReason(error)}`);
      } else if(remoteAttempted){
        await this.pool.query("UPDATE runs SET state=CASE WHEN state='cancel_requested' THEN state ELSE 'submission_unknown' END,error='SDK submission outcome is being reconciled; it will not be automatically resubmitted',updated_at=now() WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.id]);
        await this.event(run.workspace_id,run.id,"submission_unknown",{transport:"sdk"});
      } else {
        const detail=preparationFailureDetail(error);
        console.error(`[runs] ${run.id}: SDK submit stopped before any request: ${detail}`);
        const message=error instanceof EffectInputValidationError||error instanceof AlignedMaskInputError?error.message:`Workflow preparation or media upload failed before SDK submission: ${detail}`;
        if(isTransientPreparationError(error)&&await this.retryPreparation(run,message,{transport:"sdk"})==="retry")return;
        await this.finish(run,"failed",message);
      }
    }
  }
  private async reconcileSdk(run:any,worker:any){
    if(!run.remote_id){
      if(run.state==="cancel_requested"){
        const error="Cancellation is waiting for the unknown SDK submission outcome. Verify it with the proxy before marking it not accepted; it will not be resubmitted.";
        if(run.error!==error)await this.pool.query("UPDATE runs SET error=$1,updated_at=now() WHERE workspace_id=$2 AND id=$3 AND state='cancel_requested' AND remote_id IS NULL",[error,run.workspace_id,run.id]);
        return;
      }
      if(run.state!=="submission_unknown"){
        await this.pool.query("UPDATE runs SET state='submission_unknown',error='SDK submission has no external job id; it will not be automatically resubmitted',updated_at=now() WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.id]);
        await this.event(run.workspace_id,run.id,"submission_unknown",{transport:"sdk"});
        return;
      }
      // Without a job id there is nothing left to ask. After a day, end it honestly instead of showing it forever.
      if(Date.now()-new Date(run.updated_at).getTime()>SDK_UNKNOWN_GIVE_UP_MS)await this.finish(run,"failed","The SDK submission could not be confirmed within 24 hours. It was not resubmitted; start a new run if you still need it.");
      return;
    }
    const job=await sdkClient(worker).jobs.get(run.remote_id);
    await job.refresh();
    const status=job.status;
    if(run.state==="cancel_requested"){
      if(!["succeeded","failed","canceled","expired"].includes(status))await job.cancel().catch(()=>{});
      if(job.status==="canceled"){await this.finish(run,"canceled");return;}
      if(job.status==="succeeded"){await this.ingestSdk(run,job);return;}
      if(job.status==="failed"||job.status==="expired"){await this.finish(run,"failed","SDK proxy job failed before cancellation");return;}
      return;
    }
    if(status==="succeeded"){await this.ingestSdk(run,job);return;}
    if(status==="failed"||status==="expired"){await this.finish(run,"failed",sdkFailure(job));return;}
    if(status==="canceled"){await this.finish(run,"canceled");return;}
    const next=status==="running"?"running":"queued";
    if(run.state!==next){
      await this.pool.query("UPDATE runs SET state=$1,error=NULL,updated_at=now() WHERE workspace_id=$2 AND id=$3 AND state<>'cancel_requested'",[next,run.workspace_id,run.id]);
      await this.event(run.workspace_id,run.id,next);
    }
  }
  private async ingestSdk(run:any,job:Job){
    if(await this.cancelImportIfRequested(run))return;
    const graph=run.graph as Record<string,{class_type:string}>|null;
    if(!graph){await this.finish(run,"failed","Compiled SDK workflow is unavailable");return;}
    const revision=(await this.pool.query("SELECT id,sha256,manifest FROM workflow_revisions WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.workflow_revision_id])).rows[0];
    if(!revision){await this.finish(run,"failed","Pinned workflow revision is unavailable");return;}
    const manifest=revision.manifest as CapabilityBundle["manifest"];
    if(!sdkSupportsManifest(manifest)){await this.finish(run,"failed","This workflow requires its qualified native artifact transport");return;}
    const media=manifestMediaType(manifest);
    const entry:HistoryEntry={outputs:{},status:{completed:true,status_str:"success"}};
    const byName=new Map<string,Output>();
    for(const output of job.outputs){
      // Local proxy releases can label SaveVideo outputs as type=image.
      // MIME selects the candidate; decoded bytes still determine its persisted type.
      if(!output.contentType.startsWith(`${media}/`))continue;
      if(byName.has(output.name)){await this.finish(run,"failed","SDK output names are ambiguous");return;}
      const bucket=entry.outputs[output.nodeId]??(entry.outputs[output.nodeId]={});
      const field=media==="image"?"images":"videos",items=Array.isArray(bucket[field])?bucket[field] as unknown[]:[];
      bucket[field]=[...items,{filename:output.name,subfolder:"",type:"output"}];
      byName.set(output.name,output);
    }
    let files:OutputFile[];
    try{files=declaredOutputFiles(graph,entry,undefined,media);}catch{await this.finish(run,"failed","Declared SDK artifact is unavailable");return;}
    if(!files.length){await this.finish(run,"failed",`SDK workflow completed without a declared ${media} artifact`);return;}
    const limit=media==="image"?imageArtifactLimit(run,manifest):4;
    if(files.length>limit){await this.finish(run,"failed",`SDK proxy returned ${files.length} artifacts; this run accepts at most ${limit}`);return;}
    const saved:Array<{id:string;key:string;sha256:string;bytes:number;name:string;contentType?:string;metadata?:Record<string,unknown>}>=[];
    try {
      for(const file of files){
        try{media==="image"?assertSafeImageFile(file):safeOutputFile(file);}catch{throw new PermanentArtifactError("SDK proxy returned an unsafe artifact path");}
        const output=byName.get(file.filename);
        if(!output)throw new PermanentArtifactError("SDK proxy output is missing from the job");
        if(output.sizeBytes>MAX_SDK_OUTPUT_BYTES)throw new PermanentArtifactError("SDK proxy artifact exceeds its byte limit");
        const bytes=Buffer.from(await output.toBytes({timeoutMs:60000}));
        if(bytes.length>MAX_SDK_OUTPUT_BYTES)throw new PermanentArtifactError("SDK proxy artifact exceeds its byte limit");
        const stored=await this.store.put(run.workspace_id,Readable.from([bytes]));
        saved.push({id:newId(),name:file.filename,...stored});
        const last=saved[saved.length-1],filename=await this.store.file(run.workspace_id,last.key);
        try{
          const metadata=media==="image"?await probeImage(filename):await probeVideo(filename);
          if(media==="image")assertImageExtension(file.filename,(metadata as ImageMetadata).contentType);
          last.contentType=media==="image"?(metadata as ImageMetadata).contentType:(metadata as Awaited<ReturnType<typeof probeVideo>>).container?.includes("webm")?"video/webm":"video/mp4";
          last.metadata={...metadata,generation:{runId:run.id,capabilityId:run.capability_id,capabilityVersion:run.capability_version,routeId:run.route_id,workerId:run.worker_id,prompt:run.invocation?.controls?.prompt,seed:run.invocation?.controls?.seed,transport:"sdk",externalJobId:job.id}};
        }catch(error){if(error instanceof MediaProbeUnavailableError)throw error;throw new PermanentArtifactError("SDK proxy output is not valid supported media");}
      }
      const parentRole=media==="image"?manifest.inputs.find(input=>input.required&&input.type==="image")?.id:undefined;
      const parentId=parentRole?(await this.pool.query("SELECT asset_id FROM run_inputs WHERE workspace_id=$1 AND run_id=$2 AND role=$3",[run.workspace_id,run.id,parentRole])).rows[0]?.asset_id??null:null;
      const result=await transaction(this.pool,async client=>{
        const gate=await this.publicationGate(client,run);if(gate!=="publish")return gate;
        for(const asset of saved)await client.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[asset.id,run.workspace_id,run.project_id,asset.name,media,asset.contentType,asset.key,asset.sha256,asset.bytes,run.created_by,parentId,JSON.stringify(asset.metadata)]);
        await client.query("UPDATE runs SET state='succeeded',output_ids=$1,error=NULL,updated_at=now() WHERE workspace_id=$2 AND id=$3",[JSON.stringify(saved.map(a=>a.id)),run.workspace_id,run.id]);
        await client.query("INSERT INTO run_events(workspace_id,run_id,state,detail) VALUES($1,$2,'succeeded',$3)",[run.workspace_id,run.id,JSON.stringify({transport:"sdk",remoteId:job.id})]);
        return "publish" as const;
      });
      this.clearDevelop(run.id);
      if(result!=="publish")for(const asset of saved)await this.store.remove(run.workspace_id,asset.key).catch(()=>{});
    } catch(e) {
      for(const asset of saved){
        const absent=await this.pool.query("SELECT id FROM assets WHERE workspace_id=$1 AND id=$2",[run.workspace_id,asset.id]).then(r=>!r.rowCount).catch(()=>false);
        if(absent)await this.store.remove(run.workspace_id,asset.key).catch(()=>{});
      }
      const state=(await this.pool.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.id])).rows[0]?.state;
      if(state==="succeeded")return;
      if(permanentArtifactFailure(e)){await this.finish(run,"failed",`SDK output failed validation${validationFailureDetail(e)?`: ${validationFailureDetail(e)}`:""}`);return;}
      await this.pool.query("UPDATE runs SET error='SDK output import failed; reconciliation will retry without resubmitting generation.',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state NOT IN ('succeeded','failed','canceled')",[run.workspace_id,run.id]);
      throw e;
    }
  }
  private async finish(run:any,state:"failed"|"canceled",error:string|null=null) {
    this.memoryWaiting.delete(run.id);this.memoryNotes.delete(run.id);
    await transaction(this.pool,async client=>{
      const current=(await client.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[run.workspace_id,run.id])).rows[0];
      if(!current||["succeeded","failed","canceled"].includes(current.state))return;
      const finalState=current.state==="cancel_requested"?"canceled":state,finalError=finalState==="canceled"?null:error;
      await client.query("UPDATE runs SET state=$1,error=$2,updated_at=now() WHERE workspace_id=$3 AND id=$4",[finalState,finalError,run.workspace_id,run.id]);
      await client.query("UPDATE run_artifact_slots SET state='discarded',updated_at=now() WHERE workspace_id=$1 AND run_id=$2 AND state IN ('planned','staged')",[run.workspace_id,run.id]);
      await client.query("INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,$3)",[run.workspace_id,run.id,finalState]);
    });
    this.clearDevelop(run.id,true);
  }
  private async reconcile(run:any,worker:any) {
    if(run.transport==="sdk"){await this.reconcileSdk(run,worker);return;}
    if(await this.recoverStagedImageArtifacts(run,worker))return;
    if(run.state==="cancel_requested"){
      const ledgerRow=await this.motionLedger.get(run.workspace_id,run.id).catch(()=>undefined);
      if(ledgerRow&&motionRecoveryAction(run.state,ledgerRow)==="cancel_pre_post"){
        const key=await this.motionLedger.finalizePrePostCancellation(run.workspace_id,run.id).catch(()=>undefined);
        if(key!==undefined){if(key)await this.store.remove(run.workspace_id,key).catch(()=>{});return;}
      }
    }
    if(run.state==="submitting"){
      // A motion run with no durable POST marker provably never POSTed; return
      // it to pending so it is submitted exactly once. With a marker, fall
      // through to metadata reconciliation and never resubmit.
      const ledgerRow=await this.motionLedger.get(run.workspace_id,run.id).catch(()=>undefined);
      if(ledgerRow&&motionRecoveryAction(run.state,ledgerRow)==="reset_to_pending"
        &&await this.motionLedger.resetSubmittingToPending(run.workspace_id,run.id).catch(()=>false))return;
    }
    const queueResponse=await this.fetch(worker,"/queue");if(!queueResponse.ok)return;
    const queue=await queueResponse.json() as {queue_running:RawQueueItem[];queue_pending:RawQueueItem[]};
    if(!Array.isArray(queue.queue_running)||!Array.isArray(queue.queue_pending))return;
    let history:Record<string,HistoryEntry>={};
    if(!run.remote_id) {
      const historyResponse=await this.fetch(worker,"/history?max_items=1000");if(!historyResponse.ok)return;
      history=await historyResponse.json() as Record<string,HistoryEntry>;
      const matching=(tuple:RawQueueItem|undefined)=>{
        const metadata=(tuple?.[3] as {comfyfield?:{runId?:string;workspaceId?:string}}|undefined)?.comfyfield;
        return metadata?.runId===run.id&&metadata?.workspaceId===run.workspace_id;
      };
      run.remote_id=[...queue.queue_running,...queue.queue_pending].find(matching)?.[1]??Object.entries(history).find(([,entry])=>matching(entry.prompt))?.[0];
      if(!run.remote_id) {
        // A process may have crashed around POST /prompt. Never assume it was not accepted,
        // but do not hold the run forever: once the worker answers and has neither the job
        // queued nor in its history for fifteen minutes, the submission is lost (a worker
        // restart wipes that history) and the honest state is a failure the user can retry.
        const unknownSince=Date.parse(String(run.updated_at??run.created_at??""))||Date.now();
        if(run.state!=="cancel_requested"&&Date.now()-unknownSince>=SUBMISSION_UNKNOWN_LIMIT_MS){
          await this.pool.query("UPDATE runs SET state='failed',error=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.id,"The worker has no record of this run after fifteen minutes, so it was not executed. Submit it again."]);
          return;
        }
        if(run.state!=="cancel_requested")await this.pool.query("UPDATE runs SET state='submission_unknown' WHERE workspace_id=$1 AND id=$2 AND state<>'submission_unknown'",[run.workspace_id,run.id]);
        return;
      }
      await this.pool.query("UPDATE runs SET remote_id=$1,updated_at=now() WHERE workspace_id=$2 AND id=$3",[run.remote_id,run.workspace_id,run.id]);
    }
    if(!history[run.remote_id]) {
      const response=await this.fetch(worker,`/history/${encodeURIComponent(run.remote_id)}`);if(!response.ok)return;
      history=await response.json() as Record<string,HistoryEntry>;
    }
    const entry=history[run.remote_id];
    if(entry?.status?.messages?.some(([type])=>type==="execution_interrupted")) {await this.finish(run,"canceled");return;}
    if(entry?.status?.completed) {
      if(entry.status.status_str!=="success") {
        const revision=(await this.pool.query("SELECT manifest FROM workflow_revisions WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.workflow_revision_id])).rows[0];
        const media=revision?manifestMediaType(revision.manifest as CapabilityBundle["manifest"]):"output";
        await this.finish(run,"failed",`Worker did not complete the ${media}`);return;
      }
      await this.ingest(run,worker,entry);return;
    }
    if(entry?.status?.status_str==="error") {await this.finish(run,"failed",workerFailureReason(entry)??"Worker execution failed");return;}
    const pending=queue.queue_pending.some(x=>x[1]===run.remote_id),running=queue.queue_running.some(x=>x[1]===run.remote_id);
    if(run.state==="cancel_requested") {
      // Not queued, not running and not in history: the worker no longer has this prompt (for example after a
      // ComfyUI restart), so it can never produce output. Finishing here ends an otherwise endless "cancel requested".
      if(!pending&&!running){if(!entry)await this.finish(run,"canceled");return;}
      const response=await this.fetch(worker,`/jobs/${encodeURIComponent(run.remote_id)}/cancel`,{method:"POST"});
      if(response.ok&&(await response.json() as {cancelled?:boolean}).cancelled)await this.finish(run,"canceled");
      return; // Never use global interrupt on a shared worker.
    }
    if(!pending&&!running&&!entry){
      // Not queued, not running and not in history while the worker answers: ComfyUI was restarted and dropped the
      // job, so it can never produce output. Wait for one more check to rule out a job finishing between the two reads.
      if(!this.missingOnWorker.has(run.id)){this.missingOnWorker.add(run.id);return;}
      this.missingOnWorker.delete(run.id);
      await this.finish(run,"failed","ComfyUI no longer has this job, most likely because it restarted. Run it again.");return;
    }
    this.missingOnWorker.delete(run.id);
    if(pending||running) {
      const state=running?"running":"queued";
      if(run.state!==state){await this.pool.query("UPDATE runs SET state=$1,error=NULL,updated_at=now() WHERE workspace_id=$2 AND id=$3 AND state<>'cancel_requested'",[state,run.workspace_id,run.id]);await this.event(run.workspace_id,run.id,state);}
    }
  }
  private async recoverStagedImageArtifacts(run:any,worker:any):Promise<boolean>{
    const staged=(await this.pool.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE state='staged')::int AS staged FROM run_artifact_slots WHERE workspace_id=$1 AND project_id=$2 AND run_id=$3",[run.workspace_id,run.project_id,run.id])).rows[0];
    if(!staged||Number(staged.total)===0||Number(staged.staged)!==Number(staged.total))return false;
    const revision=(await this.pool.query("SELECT id,sha256,manifest FROM workflow_revisions WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.workflow_revision_id])).rows[0];
    const manifest=revision?.manifest as CapabilityBundle["manifest"]|undefined,contract=manifest?.imageArtifacts;
    if(!revision||!manifest||!contract){await this.finish(run,"failed","Staged image artifact workflow revision is unavailable");return true;}
    try{await this.ingestImageArtifacts(run,worker,undefined,revision,manifest,contract);}
    catch(error){
      if(permanentArtifactFailure(error)){await this.finish(run,"failed",`Worker image output failed validation${validationFailureDetail(error)?`: ${validationFailureDetail(error)}`:""}`);return true;}
      await this.pool.query("UPDATE runs SET error='Staged image publication is pending; reconciliation will retry without worker history.',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state NOT IN ('succeeded','failed','canceled')",[run.workspace_id,run.id]);
      throw error;
    }
    return true;
  }
  /** Last step of a video result: upscale it with the pack this workspace already has, as a chained
   *  run of the same request. The run keeps the file the tool made and gains the upscaled one in
   *  front of it once that pass publishes. Nothing here may fail the run that just succeeded: a
   *  pack that is not ready on the worker, a busy queue or a clip already tall enough leaves the
   *  result exactly as the tool made it. */
  private async chainUpscale(run:any,manifest:CapabilityBundle["manifest"],output:{id:string;metadata?:unknown}):Promise<void>{
    try{
      // An upscaled result is not upscaled again.
      if(run.invocation?.upscaleChain)return;
      const facts=output.metadata as {width?:unknown;height?:unknown}|undefined;
      const plan=planUpscale({width:Number(facts?.width??0),height:Number(facts?.height??0)});
      if(!plan)return;
      const bundle=upscaleBundle(this.catalogue),route=bundle?.manifest.routes.find(candidate=>candidate.execution==="local_comfy"&&candidate.implementation==="implemented");
      if(!bundle||!route||bundle.manifest.id===manifest.id)return;
      const key=`upscale:${run.id}`,body=requestSchema.parse({projectId:run.project_id,workerId:run.worker_id,idempotencyKey:key,capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:route.id,inputs:{source_video:output.id},controls:upscaleControls(plan),audioPolicy:"preserve"});
      const requestHash=hashToken(canonical(body));
      await transaction(this.pool,async client=>{
        const prepared=await prepareInvocation(client,this.catalogue,run.workspace_id,body,this.store);
        prepared.invocation.upscaleChain={validationVersion:1,contract:"upscale_chain_v1",parentRunId:run.id,sourceAssetId:output.id,scale:plan.scale};
        // The upscale is a step of this run, so it keeps the run's slate.
        await enqueuePreparedRun(client,run.workspace_id,run.created_by,prepared,key,requestHash,{scene:run.scene??1,shot:run.shot??1});
      });
    }catch(error){
      console.warn(`[runs] ${String(run.id)}: the upscale step was not queued: ${(error as Error).message}`);
    }
  }
  private async ingest(run:any,worker:any,entry:HistoryEntry) {
    if(await this.cancelImportIfRequested(run))return;
    const graph=run.graph as Record<string,{class_type:string}>|null;
    if(!graph)return;
    const revision=(await this.pool.query("SELECT id,sha256,manifest FROM workflow_revisions WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.workflow_revision_id])).rows[0];
    if(!revision){await this.finish(run,"failed","Pinned workflow revision is unavailable");return;}
    const manifest=revision.manifest as CapabilityBundle["manifest"];
    const contract=manifest.outputContract,imageContract=manifest.imageArtifacts,motion=motionContractFor(manifest);
    if(imageContract){
      try{await this.ingestImageArtifacts(run,worker,entry,revision,manifest,imageContract);}
      catch(error){
        if(permanentArtifactFailure(error)){await this.finish(run,"failed",manifest.posePreviewContract&&error instanceof PermanentArtifactError?error.message:"Worker image output failed validation");return;}
        await this.pool.query("UPDATE runs SET error='Image output verification or import failed; reconciliation will retry without resubmitting generation.',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state NOT IN ('succeeded','failed','canceled')",[run.workspace_id,run.id]);
        throw error;
      }
      return;
    }
    const declaredMedia=manifestMediaType(manifest);
    let motionRow:MotionLedgerStore extends never?never:Awaited<ReturnType<MotionLedgerStore["get"]>>|undefined,expectedMotion:ReturnType<typeof expectedMotionOutput>|undefined;
    if(motion&&!contract){
      motionRow=await this.motionLedger.get(run.workspace_id,run.id).catch(()=>undefined);
      if(!motionRow?.receipt){await this.finish(run,"failed","Motion preparation record is unavailable");return;}
      if(motionRow.graphDigest&&graphDigest(graph as any)!==motionRow.graphDigest){await this.finish(run,"failed","Motion graph changed after submission");return;}
      try{expectedMotion=expectedMotionOutput(manifest,run.invocation,motionRow.receipt);}catch{await this.finish(run,"failed","Motion output dimensions are unavailable");return;}
    }
    let files:OutputFile[];
    try{files=motion&&!contract?motionOutputFiles(graph,entry,motion.artifactNode):declaredOutputFiles(graph,entry,contract,declaredMedia);}catch{await this.finish(run,"failed",motion?"Pinned motion artifact node is unavailable":contract?"Pinned mask artifact node is unavailable":"Declared output artifact is unavailable");return;}
    if(!files.length){await this.finish(run,"failed",`Worker completed without a declared ${declaredMedia} artifact`);return;}
    if(declaredMedia==="image"){
      const limit=imageArtifactLimit(run,manifest);
      if(files.length>limit){await this.finish(run,"failed",`Worker returned ${files.length} image artifacts; this run accepts at most ${limit}`);return;}
    }
    if(contract){
      try{await this.ingestSourceLinkedMask(run,worker,files[0],revision,manifest,contract);}
      catch(error){
        if(permanentArtifactFailure(error)){await this.finish(run,"failed",error instanceof BackgroundMaskValidationError?error.message:"Tracked mask output failed validation");return;}
        throw error;
      }
      return;
    }
    const saved:Array<{id:string;key:string;sha256:string;bytes:number;name:string;contentType?:string;metadata?:Awaited<ReturnType<typeof probeVideo>>|ImageMetadata|Record<string,unknown>}> = [];
    try {
      for(const file of files) {
        try{declaredMedia==="image"?assertSafeImageFile(file):safeOutputFile(file);}catch{throw new PermanentArtifactError("Worker returned an unsafe artifact path");}
        const response=await this.fetch(worker,`/view?${new URLSearchParams(file)}`);
        if(!response.ok||!response.body)throw new Error("Output unavailable");
        saved.push({id:newId(),name:file.filename,...await this.store.put(run.workspace_id,Readable.fromWeb(response.body as any))});
        const last=saved[saved.length-1],filename=await this.store.file(run.workspace_id,last.key);
        if(declaredMedia==="image"){
          try{
            const image=await probeImage(filename);
            assertImageExtension(file.filename,image.contentType);
            last.contentType=image.contentType;
            last.metadata={...image,generation:{runId:run.id,capabilityId:run.capability_id,capabilityVersion:run.capability_version,routeId:run.route_id,workerId:run.worker_id,prompt:run.invocation?.controls?.prompt,seed:run.invocation?.controls?.seed}};
          }catch{throw new PermanentArtifactError("Worker output is not a valid supported image");}
        }else if(declaredMedia==="audio"){
          try{
            const probe=await probeMedia(filename,"audio");
            const ext=file.filename.split(".").pop()?.toLowerCase();
            last.contentType=ext==="wav"?"audio/wav":ext==="mp3"?"audio/mpeg":ext==="ogg"||ext==="opus"?"audio/ogg":"audio/flac";
            last.metadata={...probe,generation:{runId:run.id,capabilityId:run.capability_id,capabilityVersion:run.capability_version,routeId:run.route_id,workerId:run.worker_id,text:run.invocation?.controls?.prompt,seed:run.invocation?.controls?.seed}};
          }catch(error){if(error instanceof AudioToolUnavailableError)throw error;throw new PermanentArtifactError("Worker output is not valid audio");}
        }else if(declaredMedia==="model3d"){
          try{const glb=await probeGlb(filename);last.contentType=glb.contentType;last.metadata={...glb,generation:{runId:run.id,capabilityId:run.capability_id,capabilityVersion:run.capability_version,routeId:run.route_id,workerId:run.worker_id,seed:run.invocation?.controls?.seed}};}
          catch{throw new PermanentArtifactError("Worker output is not a valid GLB model");}
        }else{
          try{last.metadata=await probeVideo(filename);}catch(error){if(error instanceof MediaProbeUnavailableError)throw error;throw new PermanentArtifactError("Worker output is not a valid encoded video");}
          last.contentType=(last.metadata as Awaited<ReturnType<typeof probeVideo>>).container?.includes("webm")?"video/webm":"video/mp4";
          if(run.invocation.mediaSnapshot)last.metadata={...last.metadata,...await verifyMaskedOutput(filename,run.invocation.mediaSnapshot)};
          if(expectedMotion&&motionRow?.receipt){
            const verified=await this.motionDeps.verify({store:this.store,workspaceId:run.workspace_id,key:last.key},expectedMotion);
            last.metadata={...last.metadata,motionOutput:verified,motionSourceSha256:motionRow.receipt.sourceSha256,motionNormalizedSha256:motionRow.receipt.normalizedSha256,motionGraphDigest:motionRow.graphDigest};
            last.contentType="video/mp4";
          }
        }
      }
      const parentRole=declaredMedia==="image"||declaredMedia==="model3d"?manifest.inputs.find(input=>input.required&&input.type==="image")?.id:undefined;
      const parentId=parentRole?(await this.pool.query("SELECT asset_id FROM run_inputs WHERE workspace_id=$1 AND run_id=$2 AND role=$3",[run.workspace_id,run.id,parentRole])).rows[0]?.asset_id??null:null;
      const result=await transaction(this.pool,async client=>{
        const gate=await this.publicationGate(client,run);if(gate!=="publish")return gate;
        for(const asset of saved)await client.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[asset.id,run.workspace_id,run.project_id,asset.name,declaredMedia,asset.contentType,asset.key,asset.sha256,asset.bytes,run.created_by,parentId,JSON.stringify(asset.metadata)]);
        await client.query("UPDATE runs SET state='succeeded',output_ids=$1,error=NULL,updated_at=now() WHERE workspace_id=$2 AND id=$3",[JSON.stringify(saved.map(a=>a.id)),run.workspace_id,run.id]);
        await client.query("INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,'succeeded')",[run.workspace_id,run.id]);
        // A chained upscale publishes the final file: it goes in front of the run's own output.
        const chained=run.invocation?.upscaleChain as {parentRunId?:unknown}|undefined;
        if(declaredMedia==="video"&&typeof chained?.parentRunId==="string")
          await client.query("UPDATE runs SET output_ids=$1::jsonb||output_ids,updated_at=now() WHERE workspace_id=$2 AND id=$3 AND state='succeeded'",[JSON.stringify([saved[0].id]),run.workspace_id,chained.parentRunId]);
        return "publish" as const;
      });
      this.clearDevelop(run.id);
      if(result!=="publish")for(const asset of saved)await this.store.remove(run.workspace_id,asset.key).catch(()=>{});
      else if(declaredMedia==="video")await this.chainUpscale(run,manifest,saved[0]);
    } catch(e) {
      // A COMMIT acknowledgement can be lost. Never remove a possibly published artifact.
      for(const asset of saved){
        const absent=await this.pool.query("SELECT id FROM assets WHERE workspace_id=$1 AND id=$2",[run.workspace_id,asset.id]).then(r=>!r.rowCount).catch(()=>false);
        if(absent)await this.store.remove(run.workspace_id,asset.key).catch(()=>{});
      }
      const state=(await this.pool.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.id])).rows[0]?.state;
      if(state==="succeeded")return;
      if(permanentArtifactFailure(e)){await this.finish(run,"failed",`Worker output failed validation${validationFailureDetail(e)?`: ${validationFailureDetail(e)}`:""}`);return;}
      await this.pool.query("UPDATE runs SET error='Output verification or import failed; check media probing and storage. Reconciliation will retry.',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state NOT IN ('succeeded','failed','canceled')",[run.workspace_id,run.id]);
      throw e;
    }
  }
  private async ingestImageArtifacts(run:any,worker:any,entry:HistoryEntry|undefined,revision:any,manifest:CapabilityBundle["manifest"],contract:ImageArtifactsContractV1){
    const specs=exactImageArtifactSlotSpecs(contract),plans=planArtifactSlots(run.id,specs),declared:Array<{declaration:ImageArtifactDeclarationV1;ordinal:number}>=[];
    const roleOrdinals=new Map<string,number>();
    for(const declaration of contract.artifacts)for(let index=0;index<declaration.cardinality.max;index+=1){
      const ordinal=roleOrdinals.get(declaration.role)??0;roleOrdinals.set(declaration.role,ordinal+1);declared.push({declaration,ordinal});
    }
    const resolved=entry?resolveDeclaredImageArtifacts(contract,entry.outputs):undefined;
    if(resolved&&(resolved.length!==plans.length||resolved.some((artifact,index)=>artifact.declarationId!==declared[index].declaration.id||artifact.role!==plans[index].mediaType||artifact.ordinal!==plans[index].ordinal)))throw new PermanentArtifactError("Worker image outputs do not match the durable artifact plan");
    const slotRows=(await this.pool.query("SELECT * FROM run_artifact_slots WHERE workspace_id=$1 AND project_id=$2 AND run_id=$3 ORDER BY created_at,slot_id",[run.workspace_id,run.project_id,run.id])).rows;
    if(slotRows.length!==plans.length)throw new PermanentArtifactError("Durable image artifact slots are unavailable");
    const slots=plans.map(plan=>{
      const row=slotRows.find(candidate=>candidate.slot_id===plan.slotId&&candidate.asset_id===plan.assetId&&candidate.role===plan.role&&Number(candidate.ordinal)===plan.ordinal&&candidate.media_type===plan.mediaType);
      if(!row)throw new PermanentArtifactError("Durable image artifact plan changed");return row;
    });
    if(slots.some(slot=>slot.state==="discarded")){
      if(await this.cancelImportIfRequested(run))return;
      throw new PermanentArtifactError("Durable image artifact plan was discarded");
    }
    if(slots.some(slot=>slot.state==="published")){
      const outputIds=plans.map(plan=>plan.assetId),current=(await this.pool.query("SELECT state,output_ids FROM runs WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.id])).rows[0];
      if(current?.state==="succeeded"&&JSON.stringify(current.output_ids)===JSON.stringify(outputIds))return;
      throw new PermanentArtifactError("Image artifact publication state is incomplete");
    }
    const inputs=(await this.pool.query("SELECT i.role,a.* FROM run_inputs i JOIN assets a ON a.workspace_id=i.workspace_id AND a.id=i.asset_id WHERE i.workspace_id=$1 AND i.run_id=$2",[run.workspace_id,run.id])).rows;
    const inputByRole=new Map(inputs.map(asset=>[asset.role,asset]));
    const verifyPose=async()=>{try{await verifyPosePreviewInputs(this.pool,manifest,run.invocation,inputs,run.workspace_id,run.project_id,key=>this.store.file(run.workspace_id,key));}catch(error){if(error instanceof HttpError&&error.statusCode<500)throw new PermanentArtifactError(error.message);throw error;}};
    const poseMetadataFor=(outputs:Record<string,unknown>)=>{try{return posePreviewOutputMetadata(manifest,run.invocation,outputs);}catch(error){if(error instanceof HttpError&&error.statusCode<500)throw new PermanentArtifactError(error.message);throw error;}};
    const verifiedParents=new Map<string,{width:number;height:number}>();
    const verifyParent=async(role:string,declaration:ImageArtifactDeclarationV1)=>{
      const asset=inputByRole.get(role);
      if(!asset||asset.project_id!==run.project_id||!asset.storage_key)throw new PermanentArtifactError("Image artifact parent is unavailable in this project");
      if(!verifiedParents.has(role)){
        const filename=await this.store.file(run.workspace_id,asset.storage_key);
        if(await fileSha256(filename)!==asset.sha256)throw new PermanentArtifactError("Image artifact parent bytes changed before publication");
        let metadata:Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
        try{metadata=await sharp(filename,{animated:false,failOn:"warning",limitInputPixels:declaration.dimensions.maxPixels,sequentialRead:true,unlimited:false}).metadata();}
        catch{throw new PermanentArtifactError("Image artifact parent is not a valid bounded raster image");}
        if(!metadata.width||!metadata.height||metadata.width>declaration.dimensions.maxWidth||metadata.height>declaration.dimensions.maxHeight||metadata.width*metadata.height>declaration.dimensions.maxPixels)throw new PermanentArtifactError("Image artifact parent dimensions exceed the pinned policy");
        verifiedParents.set(role,{width:metadata.width,height:metadata.height});
      }
      const dimensions=verifiedParents.get(role)!;
      if(dimensions.width>declaration.dimensions.maxWidth||dimensions.height>declaration.dimensions.maxHeight||dimensions.width*dimensions.height>declaration.dimensions.maxPixels)throw new PermanentArtifactError("Image artifact parent dimensions exceed the pinned policy");
      return asset;
    };
    for(const {declaration} of declared){
      for(const parent of declaration.parents)await verifyParent(parent.inputPort,declaration);
      if(declaration.dimensions.mode==="match_input")await verifyParent(declaration.dimensions.inputPort!,declaration);
    }
    const policies=new Map<string,PngArtifactPolicy>(plans.map((plan,index)=>{
      const declaration=declared[index].declaration;
      return [plan.slotId,{maxBytes:declaration.maxBytes,maxWidth:declaration.dimensions.maxWidth,maxHeight:declaration.dimensions.maxHeight,maxPixels:declaration.dimensions.maxPixels,alpha:declaration.alpha}];
    }));
    let artifacts:StagedImageArtifact[]=[],created:StagedImageArtifact[]=[],durablyStaged=slots.every(slot=>slot.state==="staged");
    if(slots.some(slot=>slot.state==="staged")&&!durablyStaged)throw new PermanentArtifactError("Image artifact batch is only partially staged");
    try{
      await verifyPose();
      const poseMetadata=!durablyStaged?poseMetadataFor(entry?.outputs??{}):undefined;
      if(durablyStaged){
        artifacts=slots.map((slot,index)=>({...plans[index],name:slot.staged_name,contentType:slot.staged_content_type,storageKey:slot.staged_storage_key,sha256:slot.staged_sha256,bytes:Number(slot.staged_bytes),metadata:slot.staged_metadata,relations:slot.staged_relations})) as StagedImageArtifact[];
      }else{
        if(!resolved)throw new PermanentArtifactError("Worker image history is unavailable before staging");
        artifacts=[];
        for(let index=0;index<resolved.length;index+=1){
          const item=resolved[index],declaration=declared[index].declaration;
          const response=await this.fetch(worker,`/view?${new URLSearchParams(item.file)}`);
          if(!response.ok||!response.body)throw new Error("Image output is temporarily unavailable");
          const stored=await this.store.put(run.workspace_id,boundedImageStream(response.body,declaration.maxBytes));
          const relations=[];
          for(const parent of declaration.parents){
            const asset=await verifyParent(parent.inputPort,declaration);
            relations.push({assetId:asset.id,role:parent.role,ordinal:parent.order,metadata:{assetSha256:asset.sha256}});
          }
          const artifact:StagedImageArtifact={...plans[index],name:item.file.filename,contentType:"image/png",storageKey:stored.key,sha256:stored.sha256,bytes:stored.bytes,metadata:{generatedBy:{producerRunId:run.id,workflowRevisionId:revision.id,capabilityId:manifest.id,capabilityVersion:manifest.version,routeId:run.route_id,operation:item.declarationId},...(poseMetadata?{posePreview:poseMetadata[index]}:{})},relations};
          artifacts.push(artifact);created.push(artifact);
        }
      }
      try{artifacts=await validatePngArtifactBatch(artifacts,policies,async key=>readFile(await this.store.file(run.workspace_id,key)));}
      catch(error){if(error instanceof PngValidationError)throw new PermanentArtifactError("Worker output is not a valid PNG artifact");throw error;}
      for(let index=0;index<artifacts.length;index+=1){
        const declaration=declared[index].declaration;
        if(declaration.dimensions.mode!=="match_input")continue;
        const expected=verifiedParents.get(declaration.dimensions.inputPort!),validation=artifacts[index].metadata.imageValidation as {width?:number;height?:number}|undefined;
        if(!expected||validation?.width!==expected.width||validation.height!==expected.height)throw new PermanentArtifactError("Worker image output dimensions do not match the pinned input");
      }
      if(manifest.editPreservation&&!durablyStaged){
        const c=manifest.editPreservation;
        const artifact=(id:string)=>artifacts[declared.findIndex(item=>item.declaration.id===id)];
        const final=artifact(c.finalArtifact),candidate=artifact(c.candidateArtifact),mask=artifact(c.maskArtifact);
        const source=inputByRole.get(c.sourceInput);
        if(!source||!final||!candidate||!mask)throw new PermanentArtifactError("Preservation artifacts are incomplete");
        const text=entry?.outputs[c.reportNode]?.text;
        const report=Array.isArray(text)&&typeof text[0]==="string"?text[0]:undefined;
        if(!report||report.length>65536)throw new PermanentArtifactError("Upstream preservation report is missing or oversized");
        const {qa}=await measurePreservation(await this.store.file(run.workspace_id,source.storage_key),await this.store.file(run.workspace_id,final.storageKey),await this.store.file(run.workspace_id,mask.storageKey));
        const preservation={kind:c.kind,sourceAssetId:source.id,candidateAssetId:candidate.assetId,finalAssetId:final.assetId,effectiveMaskAssetId:mask.assetId,report,upstream:c.upstream,qa};
        artifacts=artifacts.map(artifact=>({...artifact,metadata:{...artifact.metadata,preservation}}));
      }
      if(manifest.posePreviewContract){
        const stored=artifacts.map(artifact=>artifact.metadata.posePreview as {pose?:unknown}|undefined),expected=poseMetadataFor({[manifest.posePreviewContract.keypointNode]:{text:[JSON.stringify(stored.map(value=>value?.pose))]}});
        if(!expected||stored.some((value,index)=>canonical(value)!==canonical(expected[index])))throw new PermanentArtifactError("Staged pose metadata changed after validation");
        await verifyPose();
      }
      const publication={workspaceId:run.workspace_id,projectId:run.project_id,runId:run.id,createdBy:run.created_by,artifacts};
      if(!durablyStaged){await recordStagedArtifactBatch(this.pool,publication);durablyStaged=true;}
      const result=await publishStagedArtifactBatch(this.pool,publication);
      this.clearDevelop(run.id);
      if(result.status==="canceled")for(const artifact of artifacts)await this.store.remove(run.workspace_id,artifact.storageKey).catch(()=>{});
    }catch(error){
      if(durablyStaged&&artifacts.length&&permanentArtifactFailure(error)){
        try{
          const published=(await this.pool.query("SELECT id FROM assets WHERE workspace_id=$1 AND id=ANY($2::uuid[])",[run.workspace_id,artifacts.map(artifact=>artifact.assetId)])).rowCount;
          if(!published){
            await this.pool.query("UPDATE run_artifact_slots SET state='discarded',updated_at=now() WHERE workspace_id=$1 AND run_id=$2 AND state='staged'",[run.workspace_id,run.id]);
            for(const artifact of artifacts)await this.store.remove(run.workspace_id,artifact.storageKey).catch(()=>{});
          }
        }catch{/* Ambiguous publication retains bytes for manual recovery. */}
      }
      if(created.length){
        let durableKeys:Set<string>|undefined;
        try{durableKeys=await durableArtifactStorageKeys(this.pool,{workspaceId:run.workspace_id,runId:run.id,assetIds:created.map(artifact=>artifact.assetId)});}catch{/* Database ambiguity retains bytes. */}
        if(durableKeys)for(const artifact of created)if(!durableKeys.has(artifact.storageKey))await this.store.remove(run.workspace_id,artifact.storageKey).catch(()=>{});
      }
      throw error;
    }
  }
  private async ingestSourceLinkedMask(run:any,worker:any,file:OutputFile,revision:any,manifest:CapabilityBundle["manifest"],contract:OutputContract){
    let outputAssetId:string,tracking:z.infer<typeof trackingSnapshotSchema>;
    try{outputAssetId=z.uuid().parse(run.invocation.outputAssetId);tracking=trackingSnapshotSchema.parse(run.invocation.trackingSnapshot);}
    catch{throw new PermanentArtifactError("Tracking invocation provenance is invalid");}
    const requirement=manifest.routes.find(route=>route.id===run.route_id)?.requirements.find(item=>item.id===contract.checkpointRequirementId&&item.kind==="model");
    const checkpointSha256=requirement?.version?.match(/^sha256:([a-f0-9]{64})$/)?.[1];
    if(!requirement||!checkpointSha256||tracking.workflowId!==manifest.id||tracking.workflowVersion!==manifest.version||tracking.routeId!==run.route_id||tracking.workflowRevisionId!==revision.id||tracking.workflowSha256!==revision.sha256||tracking.requiredCheckpoint!==requirement.name||tracking.requiredCheckpointSha256!==checkpointSha256)throw new PermanentArtifactError("Pinned tracking provenance is invalid");
    const source=(await this.pool.query("SELECT a.* FROM run_inputs i JOIN assets a ON a.workspace_id=i.workspace_id AND a.id=i.asset_id WHERE i.workspace_id=$1 AND i.run_id=$2 AND i.role=$3 AND a.project_id=$4",[run.workspace_id,run.id,contract.sourceInput,run.project_id])).rows[0];
    if(!source||source.id!==tracking.sourceAssetId||source.sha256!==tracking.sourceSha256)throw new PermanentArtifactError("Tracked source is unavailable");
    try{safeOutputFile(file);}catch{throw new PermanentArtifactError("Worker returned an unsafe artifact path");}
    let saved:{id:string;key:string;sha256:string;bytes:number;name:string}|undefined;
    try{
      const response=await this.fetch(worker,`/view?${new URLSearchParams(file)}`);
      if(!response.ok||!response.body)throw new Error("Output unavailable");
      saved={id:outputAssetId,name:file.filename,...await this.store.put(run.workspace_id,Readable.fromWeb(response.body as any))};
      const maskFile=await this.store.file(run.workspace_id,saved.key),sourceFile=await this.store.file(run.workspace_id,source.storage_key);
      const validated=await validateMaskPair(sourceFile,maskFile,{sourceAssetId:source.id,sourceSha256:source.sha256,maskSha256:saved.sha256});
      if(manifest.id==="sam31-video-background-mask")await assertBackgroundMaskRegions(maskFile,validated.width,validated.height,validated.frames);
      for(const key of ["width","height","fps","frames","timingDigest"] as const)if(validated[key]!==tracking[key])throw new PermanentArtifactError("Tracked mask does not match the frozen source geometry and timing");
      let media:Awaited<ReturnType<typeof probeVideo>>;
      try{media=await probeVideo(maskFile);}catch(error){if(error instanceof MediaProbeUnavailableError)throw error;throw new PermanentArtifactError("Tracked mask is not a supported encoded video");}
      const container=media.container??"";
      const contentType=container.includes("webm")?"video/webm":container.includes("mov")||container.includes("mp4")?"video/mp4":container.includes("matroska")?"video/x-matroska":undefined;
      if(!contentType)throw new PermanentArtifactError("Tracked mask container is unsupported");
      const sourceLinked=sourceLinkedMaskSchema.parse({
        validationVersion:1,contract:"source_linked_mask_v1",sourceAssetId:source.id,sourceSha256:source.sha256,maskAssetId:outputAssetId,maskSha256:saved.sha256,
        projectId:run.project_id,producerRunId:run.id,width:validated.width,height:validated.height,fps:validated.fps,frames:validated.frames,timingDigest:validated.timingDigest,
        semantics:contract.semantics,workflowId:manifest.id,workflowVersion:manifest.version,routeId:run.route_id,workflowRevisionId:revision.id,workflowSha256:revision.sha256,
        requiredCheckpoint:requirement.name,requiredCheckpointSha256:checkpointSha256,
      });
      const metadata={...pendingMaskMetadata(sourceLinked),maskCoverage:await inspectMaskCoverage(maskFile,validated,saved.sha256)};
      const result=await transaction(this.pool,async client=>{
        const gate=await this.publicationGate(client,run);if(gate!=="publish")return gate;
        await client.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,'mask',$5,$6,$7,$8,$9,$10,$11)",[saved!.id,run.workspace_id,run.project_id,saved!.name,contentType,saved!.key,saved!.sha256,saved!.bytes,run.created_by,source.id,JSON.stringify(metadata)]);
        await client.query("UPDATE runs SET state='succeeded',output_ids=$1,error=NULL,updated_at=now() WHERE workspace_id=$2 AND id=$3",[JSON.stringify([saved!.id]),run.workspace_id,run.id]);
        await client.query("INSERT INTO run_events(workspace_id,run_id,state,detail) VALUES($1,$2,'succeeded',$3)",[run.workspace_id,run.id,JSON.stringify({outputAssetId:saved!.id,mediaType:"mask",reviewState:"pending"})]);
        return "published" as const;
      });
      if(result==="canceled")await this.store.remove(run.workspace_id,saved.key).catch(()=>{});
      else if(result==="published"){
        const existing=(await this.pool.query("SELECT storage_key,sha256 FROM assets WHERE workspace_id=$1 AND id=$2",[run.workspace_id,outputAssetId])).rows[0];
        if(!existing||existing.storage_key!==saved.key||existing.sha256!==saved.sha256)await this.store.remove(run.workspace_id,saved.key).catch(()=>{});
      }
    }catch(error){
      // A COMMIT acknowledgement can be lost. Re-read the deterministic run and
      // asset IDs before removing bytes or reporting a retryable import failure.
      const published=(await this.pool.query("SELECT r.state,a.id,a.storage_key,a.sha256 FROM runs r LEFT JOIN assets a ON a.workspace_id=r.workspace_id AND a.id=$3 WHERE r.workspace_id=$1 AND r.id=$2",[run.workspace_id,run.id,outputAssetId])).rows[0];
      if(published?.state==="succeeded"&&published.id&&saved&&published.storage_key===saved.key&&published.sha256===saved.sha256)return;
      if(saved&&!published?.id)await this.store.remove(run.workspace_id,saved.key).catch(()=>{});
      if(published?.state!=="succeeded"&&!permanentArtifactFailure(error))await this.pool.query("UPDATE runs SET error='Tracked mask verification or import failed; reconciliation will retry.',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state NOT IN ('succeeded','failed','canceled')",[run.workspace_id,run.id]);
      throw error;
    }
  }
}

/** The steps of one request share the start of their idempotency key; each step is the next part, so a
 *  second run of the same request reads as part 2 instead of a restart. */
async function chainPartOf(pool:Pool,workspaceId:string,key:string|undefined|null):Promise<JobPart|undefined>{
  const prefix=chainKeyPrefix(key);
  if(!prefix||!key)return undefined;
  const keys=(await pool.query("SELECT idempotency_key FROM runs WHERE workspace_id=$1 AND left(idempotency_key,length($2))=$2 ORDER BY created_at,id",[workspaceId,prefix])).rows.map((row:any)=>row.idempotency_key as string);
  return chainPart(keys,key);
}

export async function executionRoutes(app:FastifyInstance,pool:Pool,store:DiskStore,catalogue:CapabilityBundle[],registry:DirectRegistry=productionDirectRegistry,cancelNative?:(workspace:string,id:string)=>Promise<void>) {
  const service=new ExecutionService(pool,store,catalogue);
  jobFeedRoutes(app,pool,id=>service.developFrame(id));
  app.post(`${base}/runs`,async request=>{
    const {workspaceId}=ws.parse(request.params),user=await member(pool,request,workspaceId,"creator");
    const body=admissionSchema.parse(request.body),requestHash=hashToken(canonical(body));
    const scopedCatalogue=await loadWorkspaceCatalogue(pool,catalogue,workspaceId);
    return transaction(pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${workspaceId}/${body.idempotencyKey}`]);
      const old=(await client.query(`SELECT ${publicColumns},request_hash FROM runs WHERE workspace_id=$1 AND idempotency_key=$2`,[workspaceId,body.idempotencyKey])).rows[0];
      if(old){if(old.request_hash!==requestHash)throw new HttpError(409,"Idempotency key was already used for a different request");delete old.request_hash;if(!old.worker_id)old.remote_id=null;return old;}
      const bundle=scopedCatalogue.find(b=>b.manifest.id===body.capabilityId);
      if(bundle?.manifest.mediaContract?.kind==="aligned_video_mask_v1"){
        const tools=await maskedEditReadiness();
        if(tools.state!=="ready")throw new HttpError(422,tools.state==="install_required"?`Masked editing installation required: ${tools.missing.join(", ")}. ${tools.instructions}`:`Masked editing check incomplete. ${tools.instructions}`);
      }
      const route=bundle?.manifest.routes.find(r=>r.id===body.routeId);
      if(route?.execution==="direct_provider")return enqueueDirect(client,scopedCatalogue,registry,workspaceId,user.id,body,requestHash);
      /* A cloud route is admitted here, with the cloud worker's own probe as its readiness. A panel
         that only knows the pack's local route still reaches the cloud: prepareInvocation asks the
         chosen worker, so every chain and storyboard step keeps the worker a person picked. */
      if(bundle&&isCloudRoute(bundle.manifest,body.routeId)){
        if(body.workerId===undefined)throw new HttpError(422,CLOUD_WORKER_REASON);
        const prepared=await prepareCloudInvocation(client,scopedCatalogue,workspaceId,requestSchema.parse(body));
        return enqueuePreparedRun(client,workspaceId,user.id,prepared,body.idempotencyKey,requestHash);
      }
      const prepared=await prepareInvocation(client,scopedCatalogue,workspaceId,requestSchema.parse(body),store);
      return enqueuePreparedRun(client,workspaceId,user.id,prepared,body.idempotencyKey,requestHash);
    });
  });
  app.get(`${base}/runs`,async request=>{const {workspaceId}=ws.parse(request.params);await member(pool,request,workspaceId);const query=z.object({projectId:z.uuid().optional()}).strict().parse(request.query);const rows=(await pool.query(`SELECT ${publicColumns} FROM runs WHERE workspace_id=$1 AND ($2::uuid IS NULL OR project_id=$2) ORDER BY created_at DESC LIMIT 200`,[workspaceId,query.projectId??null])).rows;
    const ids=[...new Set(rows.map(row=>row.output_ids?.[0]).filter((id):id is string=>typeof id==="string"&&/^[a-f0-9-]{36}$/i.test(id)))];
    const types=new Map((ids.length?(await pool.query("SELECT id,content_type FROM assets WHERE workspace_id=$1 AND id=ANY($2::uuid[])",[workspaceId,ids])).rows:[]).map(asset=>[asset.id,asset.content_type]));
    return rows.map(row=>({...row,remote_id:row.worker_id?row.remote_id:null,output_content_type:types.get(row.output_ids?.[0])??null}));});
  app.get(`${base}/runs/:id`,async request=>{const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId);const row=(await pool.query(`SELECT ${publicColumns},invocation FROM runs WHERE workspace_id=$1 AND id=$2`,[workspaceId,id])).rows[0];if(!row)throw new HttpError(404,"Run not found");if(!row.worker_id)row.remote_id=null;return row;});
  app.get(`${base}/runs/:id/provenance`,async request=>{
    const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId);
    const run=(await pool.query("SELECT invocation,output_ids,capability_id,capability_version,workflow_revision_id,route_id FROM runs WHERE workspace_id=$1 AND id=$2",[workspaceId,id])).rows[0];
    if(!run)throw new HttpError(404,"Run not found");
    const pinned=(await pool.query("SELECT binding,binding_hash FROM provider_run_bindings WHERE workspace_id=$1 AND run_id=$2",[workspaceId,id])).rows[0];
    const revision=run.workflow_revision_id?(await pool.query("SELECT sha256,manifest FROM workflow_revisions WHERE workspace_id=$1 AND id=$2",[workspaceId,run.workflow_revision_id])).rows[0]:undefined;
    const inputs=(await pool.query("SELECT r.role,a.id,a.sha256,a.media_type FROM run_inputs r JOIN assets a ON a.workspace_id=r.workspace_id AND a.id=r.asset_id WHERE r.workspace_id=$1 AND r.run_id=$2 ORDER BY r.role",[workspaceId,id])).rows;
    const outputIds=z.array(z.uuid()).catch([]).parse(run.output_ids);
    const outputRows=outputIds.length?(await pool.query("SELECT id,project_id,parent_id,name,media_type,content_type,sha256,bytes,created_at,metadata FROM assets WHERE workspace_id=$1 AND id=ANY($2::uuid[])",[workspaceId,outputIds])).rows:[];
    const outputs=outputIds.map((outputId:string)=>outputRows.find((asset:any)=>asset.id===outputId)).filter(Boolean).map(publicOutputLineage);
    delete run.workflow_revision_id;
    if(run.route_id==='chatgpt-native')return {...run,outputs,execution:'native_codex',provider:'chatgpt',model:run.invocation.native.model,inputs};
    return {...run,outputs,execution:pinned?"direct_provider":"local_comfy",...(pinned?{provider:pinned.binding.provider,model:pinned.binding.model,adapterId:pinned.binding.adapterId,adapterVersion:pinned.binding.adapterVersion,bindingHash:pinned.binding_hash}:{workflowHash:revision?.sha256,modelRequirements:revision?.manifest.routes.find((r:any)=>r.id===run.invocation.routeId)?.requirements.filter((r:any)=>r.kind==="model"),inputs})};
  });
  app.get(`${base}/runs/:id/preservation/drift`,async(request,reply)=>{
    const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId);
    const row=(await pool.query("SELECT a.*,r.project_id AS run_project FROM runs r JOIN assets a ON a.workspace_id=r.workspace_id AND a.id::text IN (SELECT jsonb_array_elements_text(r.output_ids)) WHERE r.workspace_id=$1 AND r.id=$2 AND r.state='succeeded' AND a.metadata->'preservation'->>'finalAssetId'=a.id::text",[workspaceId,id])).rows[0];
    const p=row?.metadata?.preservation;
    if(!p||p.kind!=="klein_still_v1")throw new HttpError(404,"No measured preservation result for this run");
    const input=(await pool.query("SELECT asset_id FROM run_inputs WHERE workspace_id=$1 AND run_id=$2 AND asset_id=$3",[workspaceId,id,p.sourceAssetId])).rows[0];
    if(!input)throw new HttpError(422,"Preservation source no longer matches the run");
    const assets=(await pool.query("SELECT id,storage_key,sha256 FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])",[workspaceId,row.run_project,[p.sourceAssetId,p.finalAssetId,p.effectiveMaskAssetId]])).rows;
    const byId=new Map(assets.map(asset=>[asset.id,asset]));
    const file=async(assetId:string)=>{
      const asset=byId.get(assetId);if(!asset)throw new HttpError(422,"Preservation media is unavailable");
      const filename=await store.file(workspaceId,asset.storage_key);
      if(await fileSha256(filename)!==asset.sha256)throw new HttpError(422,"Preservation media changed since publication");
      return filename;
    };
    const {driftPng}=await measurePreservation(await file(p.sourceAssetId),await file(p.finalAssetId),await file(p.effectiveMaskAssetId),true);
    return reply.header("Content-Type","image/png").header("Cache-Control","no-store").send(driftPng);
  });
  app.get(`${base}/runs/:id/develop`,async request=>{
    const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId);
    const run=(await pool.query("SELECT state,graph,idempotency_key FROM runs WHERE workspace_id=$1 AND id=$2",[workspaceId,id])).rows[0];
    if(!run)throw new HttpError(404,"Run not found");
    const frame=service.developFrame(id);
    // What the job is doing now, and which part of it this is: a window of a chained replace, or the
    // next run of a request that takes several. Both name the part, so a second run of one request
    // reads as the next part instead of starting over.
    const stage=stageForNode(run.graph,frame?.node);
    const part=scailChunkParts(run.graph,frame?.node)??await chainPartOf(pool,workspaceId,run.idempotency_key);
    return {
      active:["pending","submitting","submission_unknown","queued","running","cancel_requested"].includes(run.state),
      ...(run.state==="pending"&&service.waitingForMemory(id)?{waiting:"memory" as const,...(service.memoryNote(id)?{waitingNote:service.memoryNote(id)}:{})}:{}),
      preview:!!frame?.preview.length,value:frame?.value??null,max:frame?.max??null,node:frame?.node??null,
      ...(stage?{stage}:{}),...(part?{part:part.part,parts:part.parts}:{}),
      seq:frame?.seq??0,updatedAt:frame?new Date(frame.updatedAt).toISOString():null,
    };
  });
  app.get(`${base}/runs/:id/preview`,async(request,reply)=>{
    const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId);
    const frame=service.developFrame(id);
    if(!frame?.preview.length)throw new HttpError(404,"No live preview frame");
    return reply.header("Cache-Control","no-store").header("Content-Type",frame.contentType).send(frame.preview);
  });
  app.get(`${base}/runs/:id/events`,async request=>{const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId);const {after}=z.object({after:z.coerce.number().int().min(0).default(0)}).parse(request.query);return(await pool.query("SELECT seq,state,detail,created_at FROM run_events WHERE workspace_id=$1 AND run_id=$2 AND seq>$3 ORDER BY seq LIMIT 200",[workspaceId,id,after])).rows;});
  app.post(`${base}/runs/:id/cancel`,async request=>{
    const {workspaceId,id}=item.parse(request.params),user=await member(pool,request,workspaceId,"creator");
    const run=(await pool.query("SELECT * FROM runs WHERE workspace_id=$1 AND id=$2",[workspaceId,id])).rows[0];if(!run)throw new HttpError(404,"Run not found");
    if(user.role!=="admin"&&run.created_by!==user.id)throw new HttpError(403,"Only the run owner or an administrator may cancel");
    const state=await transaction(pool,client=>cancelRun(client,workspaceId,id));
    if(state==="canceled")service.clearMemoryWait(id);
    if(run.route_id==='chatgpt-native'){await cancelNative?.(workspaceId,id);return {state:(await pool.query('SELECT state FROM runs WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0]?.state??state};}
    return {state:state??run.state};
  });
  app.post(`${base}/runs/:id/retry-publication`,async request=>{
    const {workspaceId,id}=item.parse(request.params),user=await member(pool,request,workspaceId,"creator");
    z.object({}).strict().parse(request.body??{});
    const run=(await pool.query("SELECT created_by FROM runs WHERE workspace_id=$1 AND id=$2",[workspaceId,id])).rows[0];
    if(!run)throw new HttpError(404,"Run not found");
    if(user.role!=="admin"&&run.created_by!==user.id)throw new HttpError(403,"Only the run owner or an administrator may recover publication");
    return service.retryImagePublication(workspaceId,id);
  });
  app.post(`${base}/runs/:id/resolve-unknown`,async request=>{
    const {workspaceId,id}=item.parse(request.params),user=await member(pool,request,workspaceId,"creator");
    const run=(await pool.query("SELECT * FROM runs WHERE workspace_id=$1 AND id=$2",[workspaceId,id])).rows[0];if(!run)throw new HttpError(404,"Run not found");
    if(user.role!=="admin"&&run.created_by!==user.id)throw new HttpError(403,"Only the run owner or an administrator may resolve this run");
    const waiting=(row:any)=>row.state==="submission_unknown"||(row.state==="cancel_requested"&&!row.remote_id);
    if(!waiting(run))throw new HttpError(409,"Run is not waiting for submission reconciliation");
    const manual=z.object({resolution:z.literal("mark_failed")}).strict().optional().parse(request.body??undefined);
    const closeNotAccepted=async(isManual:boolean)=>transaction(pool,async client=>{
      const current=(await client.query("SELECT state,remote_id FROM runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,id])).rows[0];
      if(!current||!waiting(current))throw new HttpError(409,"Run state changed while resolving its submission");
      const state=current.state==="cancel_requested"?"canceled":"failed";
      const error=state==="canceled"?null:isManual
        ?"Submission manually marked as not accepted after external verification"
        :"Submission confirmed not accepted by the worker (resolved manually)";
      await client.query("UPDATE runs SET state=$1,error=$2,updated_at=now() WHERE workspace_id=$3 AND id=$4",[state,error,workspaceId,id]);
      await client.query("UPDATE run_artifact_slots SET state='discarded',updated_at=now() WHERE workspace_id=$1 AND run_id=$2 AND state IN ('planned','staged')",[workspaceId,id]);
      await client.query("INSERT INTO run_events(workspace_id,run_id,state,detail) VALUES($1,$2,$3,$4)",[workspaceId,id,state,JSON.stringify({manual:isManual,resolution:"not_accepted",actorId:user.id,transport:run.transport})]);
      return {state,...(isManual?{manual:true}:{})};
    });
    if(manual)return closeNotAccepted(true);
    if(run.transport==="sdk")throw new HttpError(422,"SDK submissions cannot be resolved from native ComfyUI history. Verify the proxy job externally, then explicitly mark the submission not accepted if confirmed.");
    const worker=run.worker_id?(await pool.query("SELECT * FROM workers WHERE workspace_id=$1 AND id=$2",[workspaceId,run.worker_id])).rows[0]:undefined;
    if(!worker)throw new HttpError(422,"Run has no worker to verify against; it stays submission_unknown");
    const call=async(path:string)=>{const response=await fetch(`${worker.origin}${worker.api_prefix}${path}`,{redirect:"error",signal:AbortSignal.timeout(20000)});if(!response.ok)throw new HttpError(422,"Worker did not answer; run stays submission_unknown");return response.json() as Promise<any>;};
    let queue:any,history:Record<string,any>;
    try{queue=await call("/queue");history=await call("/history?max_items=1000") as Record<string,any>;}
    catch(error){if(error instanceof HttpError)throw error;throw new HttpError(422,"Worker did not answer; run stays submission_unknown");}
    if(!queue||!Array.isArray(queue.queue_running)||!Array.isArray(queue.queue_pending)||!history||typeof history!=="object")throw new HttpError(422,"Worker returned an unreadable queue or history; run stays submission_unknown");
    const matching=(tuple:any)=>{
      const metadata=(Array.isArray(tuple)?tuple[3]:undefined) as {comfyfield?:{runId?:string;workspaceId?:string}}|undefined;
      return metadata?.comfyfield?.runId===run.id&&metadata?.comfyfield?.workspaceId===workspaceId;
    };
    const discovered=run.remote_id??[...queue.queue_running,...queue.queue_pending].find(matching)?.[1]??Object.entries(history).find(([,entry]:[string,any])=>matching(entry?.prompt))?.[0];
    if(discovered){
      if(history[discovered]||queue.queue_running.some((tuple:any)=>tuple?.[1]===discovered)||queue.queue_pending.some((tuple:any)=>tuple?.[1]===discovered)){
        const next=await transaction(pool,async client=>{
          const current=(await client.query("SELECT state,remote_id FROM runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,id])).rows[0];
          if(!current||!waiting(current))throw new HttpError(409,"Run state changed while resolving its submission");
          const state=current.state==="cancel_requested"?"cancel_requested":"queued";
          await client.query("UPDATE runs SET remote_id=$1,state=$2,error=NULL,updated_at=now() WHERE workspace_id=$3 AND id=$4",[discovered,state,workspaceId,id]);
          await client.query("INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,$3)",[workspaceId,id,state]);
          return state;
        });
        return {state:next,remoteId:discovered};
      }
    }
    return closeNotAccepted(false);
  });
  app.get(`${base}/runs/:id/workflow`,async request=>{
    const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId);
    const row=(await pool.query("SELECT graph,capability_id,capability_version,workflow_revision_id,invocation FROM runs WHERE workspace_id=$1 AND id=$2",[workspaceId,id])).rows[0];
    if(!row?.graph)throw new HttpError(404,"Resolved graph is not available yet");
    const serialized=JSON.stringify(row.graph);
    return {contractVersion:1,capabilityId:row.capability_id,version:row.capability_version,workflowRevisionId:row.workflow_revision_id??null,routeId:row.invocation?.routeId??null,graphSha256:createHash("sha256").update(serialized,"utf8").digest("hex"),graph:row.graph};
  });
  return service;
}


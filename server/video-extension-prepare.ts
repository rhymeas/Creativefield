import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createReadStream} from "node:fs";
import {lstat,mkdir,mkdtemp,realpath,rm} from "node:fs/promises";
import path from "node:path";
import type {Pool,PoolClient} from "pg";
import {HttpError} from "./auth";
import {newId} from "./crypto";
import {transaction} from "./db";
import {MOTION_LIMITS} from "./motion-media";
import type {DiskStore} from "./storage";
import type {ResolvedRunAsset} from "./element-inputs";
import type {CleanSourceSnapshot} from "../src/capabilities/types";
import {findCleanRegion,type CleanRegion} from "./video-content-region";
import {removeOverlays,type OverlayBox,type OverlayRemoval} from "./video-overlay-mask";
import {fileSha256AndBytes,inspectNormalizedVideo,type NormalizedVideoFacts,VideoExtensionMediaError,VideoExtensionToolUnavailableError,videoExtensionReadiness} from "./video-extension-media";

const execute=promisify(execFile);
/** One clip re-encode may run for five minutes; the caller's connection ending stops it. */
const PREPARE_TIMEOUT_MS=5*60*1000;
const PROBE_MAX_BYTES=8*1024*1024,ENCODE_MAX_OUTPUT_BYTES=2*1024*1024;
/** A clean copy made by an older region finder or without the overlay step is made again instead of reused. */
const CLEAN_REGION_VERSION=5;
const assetColumns="id,project_id,name,media_type,content_type,sha256,bytes,parent_id,created_at,metadata";

export type VideoAssetRow={id:string;project_id:string;name:string;media_type:string;content_type:string;sha256:string;bytes:string|number;parent_id:string|null;created_at:Date|string;metadata:Record<string,unknown>};
/** A prepared clip; `cleaned` is only present when the caller asked for a clean source. */
export type PreparedVideoSource=VideoAssetRow&{cleaned?:boolean};
type SourceAssetRow=VideoAssetRow&{storage_key:string;created_by?:string};
type PrepareQuery=(text:string,values?:unknown[])=>Promise<{rows:any[]}>;
/** The two database calls a prepare makes. The run that needs the copy hands in its own
 *  transaction, so the copy is made inside the run's admission instead of beside it. */
export type PrepareDb={query:PrepareQuery;transaction:<T>(work:(client:{query:PrepareQuery})=>Promise<T>)=>Promise<T>};
type ProbeStream={codec_type?:string;avg_frame_rate?:string;r_frame_rate?:string};
type SourceProbe={audio:boolean;averageRate:number};

/** A previous screen crop still needs overlay removal inside its remaining frame.
 * Only reuse its geometry when the recorded parent and decoded dimensions agree. */
function priorCropFrame(source:SourceAssetRow,facts:NormalizedVideoFacts):CleanRegion|null{
  const previous=source.metadata?.videoPrepare as {clean?:boolean;sourceAssetId?:string;region?:{width?:number;height?:number;aspect?:string};output?:{width?:number;height?:number}}|undefined;
  if(previous?.clean!==true||!source.parent_id||previous.sourceAssetId!==source.parent_id
    ||previous.region?.width!==facts.width||previous.region.height!==facts.height
    ||previous.output?.width!==facts.width||previous.output.height!==facts.height)return null;
  return {x:0,y:0,width:facts.width,height:facts.height,aspect:previous.region.aspect??`${facts.width}:${facts.height}`,frame:{width:facts.width,height:facts.height}};
}

function unreadable():never{throw new HttpError(422,"This file is not a video the server can read.");}
function aborted(signal:AbortSignal):never{
  throw signal.reason instanceof Error&&signal.reason.name==="TimeoutError"
    ?new HttpError(504,"Making this clip ready took longer than five minutes.")
    :new HttpError(499,"Clip preparation was canceled.");
}
function assetView(row:VideoAssetRow):VideoAssetRow{
  return {id:row.id,project_id:row.project_id,name:row.name,media_type:row.media_type,content_type:row.content_type,sha256:row.sha256,bytes:row.bytes,parent_id:row.parent_id,created_at:row.created_at,metadata:row.metadata};
}

let active=0;
/** Bound the whole-clip decodes this route starts, like the other clip checks. */
async function withPrepareSlot<T>(work:()=>Promise<T>):Promise<T>{
  if(active>=MOTION_LIMITS.maxConcurrent)throw new HttpError(429,"Clip preparation is busy. Try again in a moment.");
  active++;
  try{return await work();}finally{active--;}
}

function parseFrameRate(value:string|undefined){
  if(!value)return null;
  const [numerator,denominator]=value.split("/").map(Number);
  if(!Number.isSafeInteger(numerator)||!Number.isSafeInteger(denominator)||numerator<=0||denominator<=0)return null;
  const ratio=numerator/denominator;
  return Number.isFinite(ratio)&&ratio>0?ratio:null;
}

/** The source frame rate kept for the ready clip: the clip's own average, rounded and clamped to 8-60. */
export function readyFrameRate(average:number){return Math.min(60,Math.max(8,Math.round(average)));}

/** A source that already satisfies the frame contract is returned as itself, never copied. */
async function inspectSource(filename:string,signal:AbortSignal){
  try{return await inspectNormalizedVideo(filename,signal);}
  catch(error){
    if(signal.aborted)aborted(signal);
    if(error instanceof VideoExtensionToolUnavailableError)throw new HttpError(503,"The server cannot make clips ready right now.");
    if(error instanceof VideoExtensionMediaError)return null;
    throw unreadable();
  }
}

async function probeSource(filename:string,signal:AbortSignal):Promise<SourceProbe>{
  let stdout:string;
  try{
    stdout=String((await execute(process.env.FFPROBE_PATH??"ffprobe",["-v","error","-protocol_whitelist","file,pipe","-show_streams","-show_format","-of","json",filename],{windowsHide:true,timeout:30000,maxBuffer:PROBE_MAX_BYTES,signal})).stdout);
  }catch(error){
    if(signal.aborted)aborted(signal);
    const failure=error as NodeJS.ErrnoException&{killed?:boolean;signal?:string};
    if(failure.code==="ENOENT"||failure.code==="EACCES"||failure.killed||failure.signal)throw new HttpError(503,"The server cannot make clips ready right now.");
    unreadable();
  }
  let streams:ProbeStream[];
  try{streams=(JSON.parse(stdout!) as {streams?:ProbeStream[]}).streams??[];}catch{unreadable();}
  const video=streams.find(stream=>stream.codec_type==="video");
  if(!video)unreadable();
  const averageRate=parseFrameRate(video.avg_frame_rate)??parseFrameRate(video.r_frame_rate);
  if(averageRate===null)throw new HttpError(422,"This clip has no readable frame rate.");
  return {audio:streams.some(stream=>stream.codec_type==="audio"),averageRate};
}

/** Ask the content-region finder for the clean picture; a clip it cannot read has no clean region. */
async function cleanRegion(filename:string,signal:AbortSignal):Promise<CleanRegion|null>{
  try{return await findCleanRegion(filename,signal);}
  catch(error){
    if(signal.aborted)aborted(signal);
    if(error instanceof VideoExtensionToolUnavailableError)throw new HttpError(503,"The server cannot make clips ready right now.");
    if(error instanceof VideoExtensionMediaError)return null;
    throw unreadable();
  }
}

/** The local ComfyUI an overlay inpaint may run on, if this workspace has one enabled. */
async function overlayWorker(db:{query:PrepareQuery},workspaceId:string):Promise<{origin:string;api_prefix?:string}|undefined>{
  try{
    const row=(await db.query("SELECT origin,api_prefix FROM workers WHERE workspace_id=$1 AND enabled=true ORDER BY checked_at DESC NULLS LAST,id LIMIT 1",[workspaceId])).rows[0] as {origin?:unknown;api_prefix?:unknown}|undefined;
    return typeof row?.origin==="string"&&row.origin?{origin:row.origin,api_prefix:typeof row.api_prefix==="string"?row.api_prefix:undefined}:undefined;
  }catch{return undefined;}
}

async function readyAsset(db:{query:PrepareQuery},workspaceId:string,projectId:string,sourceSha256:string,clean:boolean,fps?:number):Promise<VideoAssetRow|undefined>{
  return (await db.query(`SELECT ${assetColumns} FROM assets WHERE workspace_id=$1 AND project_id=$2 AND media_type='video' AND metadata->'videoPrepare'->>'sourceSha256'=$3 AND COALESCE(metadata->'videoPrepare'->>'clean','false')=$4 AND COALESCE(metadata->'videoPrepare'->>'fps','')=$5 AND (COALESCE(metadata->'videoPrepare'->>'clean','false')<>'true' OR (COALESCE(metadata->'videoPrepare'->>'cleanVersion','')=$6 AND metadata->'videoPrepare'->'overlay'->>'state' IN ('removed','none'))) ORDER BY created_at LIMIT 1`,[workspaceId,projectId,sourceSha256,String(clean),fps===undefined?"":String(fps),String(CLEAN_REGION_VERSION)])).rows[0];
}

/** What a clean clip says about the overlays that sat on it: gone, none found, not this time. */
type OverlayStep={file:string;facts?:NormalizedVideoFacts;state:"removed"|"none"|"unavailable"|"incomplete";coverage?:number;regions?:OverlayBox[]};

/**
 * Report overlay removal separately from cropping. The caller refuses partial or
 * unavailable removal; completed windows can be reused on an explicit retry.
 */
async function overlayFree(db:PrepareDb,store:DiskStore,workspaceId:string,cacheKey:string,input:{cropped:string;painted:string;facts:NormalizedVideoFacts;fps:number;audio:boolean;signal:AbortSignal}):Promise<OverlayStep>{
  const cache=path.join(store.root,".video-prepare","overlay",`${CLEAN_REGION_VERSION}-${input.fps}-${cacheKey}`);
  let removal:OverlayRemoval;
  try{
    await mkdir(cache,{recursive:true});
    removal=await removeOverlays({clip:input.cropped,frames:input.facts.frameCount,fps:input.fps,cache,worker:await overlayWorker(db,workspaceId),signal:input.signal});
  }catch(error){
    if(input.signal.aborted)aborted(input.signal);
    return {file:input.cropped,state:"unavailable"};
  }
  const receipt=removal.mask?{coverage:Number(removal.mask.coverage.toFixed(4)),regions:removal.mask.regions}:{};
  if(removal.state!=="removed")return {file:input.cropped,state:removal.state,...receipt};
  try{
    await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin","-y","-protocol_whitelist","file,pipe",
      "-f","concat","-safe","0","-i",removal.list,"-i",input.cropped,"-map","0:v:0",
      ...(input.audio?["-map","1:a:0","-c:a","copy"]:["-an"]),
      "-vf",`setpts=PTS-STARTPTS,fps=${input.fps},setsar=1,format=yuv420p`,"-fps_mode","cfr",
      "-c:v","libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p","-map_metadata","-1","-map_chapters","-1",
      "-movflags","+faststart","-avoid_negative_ts","auto","-fs",String(store.maxBytes+1),input.painted],{windowsHide:true,maxBuffer:ENCODE_MAX_OUTPUT_BYTES,signal:input.signal});
    const facts=await inspectNormalizedVideo(input.painted,input.signal);
    // The painted clip replaces the picture frame for frame or it is not used at all.
    if(facts.frameCount!==input.facts.frameCount)throw new Error("overlay inpaint changed the frame count");
    await rm(cache,{recursive:true,force:true}).catch(()=>{});
    return {file:input.painted,facts,state:"removed",...receipt};
  }catch(error){
    if(input.signal.aborted)aborted(input.signal);
    return {file:input.cropped,state:"incomplete",...receipt};
  }
}

/**
 * Make a project clip ready for trimming: re-encode it once to a constant frame rate with
 * zero-based timestamps and store it as a new "<name> (ready)" video asset. The frame
 * contract in inspectNormalizedVideo is never loosened; a source that already passes it is
 * returned unchanged, and the same source bytes in the same project reuse the ready copy.
 * With `clean:true` the moving picture inside a screen recording is cropped out under a
 * standard aspect first, the still app overlays that sit on that picture are painted away by
 * a local video inpaint, and the result is stored as "<name> (clean)"; a clip with no such
 * picture is returned unchanged with `cleaned:false`. With `fps`, a clip faster than that rate is
 * resampled to exactly it and stored as "<name> (ready <fps> fps)"; a clip at or below
 * it keeps its own rate. `createdBy` names the person a derived asset belongs to; without
 * it the source's own owner is used, because a run does not choose an owner.
 */
async function prepareVideoAsset(db:PrepareDb,store:DiskStore,workspaceId:string,input:{projectId:string;assetId:string;clean?:boolean;fps?:number;createdBy?:string},cancel?:AbortSignal):Promise<PreparedVideoSource>{
  return withPrepareSlot(async()=>{
    cancel?.throwIfAborted();
    const signal=cancel?AbortSignal.any([cancel,AbortSignal.timeout(PREPARE_TIMEOUT_MS)]):AbortSignal.timeout(PREPARE_TIMEOUT_MS),clean=input.clean===true;
    const source=(await db.query(`SELECT ${assetColumns},storage_key,created_by FROM assets WHERE workspace_id=$1 AND id=$2 AND project_id=$3`,[workspaceId,input.assetId,input.projectId])).rows[0] as SourceAssetRow|undefined;
    if(!source)throw new HttpError(404,"Project video source not found");
    if(source.media_type!=="video")unreadable();
    const createdBy=input.createdBy??source.created_by;
    if(!createdBy)throw new HttpError(422,"The source video is unavailable");
    const file=await store.file(workspaceId,source.storage_key).catch(()=>unreadable());
    const hash=await fileSha256AndBytes(file).catch(()=>unreadable());
    if(hash.sha256!==source.sha256||hash.bytes!==Number(source.bytes))throw new HttpError(422,"The stored clip does not match this asset.");
    let region=clean?await cleanRegion(file,signal):null;
    // Already-cropped screen recordings have no outer chrome for the finder to
    // rediscover. Their recorded crop is evidence to check the remaining overlays.
    if(clean&&!region&&source.metadata?.videoPrepare){
      region=priorCropFrame(source,await inspectNormalizedVideo(file,signal));
    }
    if(clean&&!region)return {...assetView(source),cleaned:false};
    let probe:SourceProbe|undefined;
    const probeOnce=async()=>probe??=await probeSource(file,signal);
    // A requested rate only applies when the clip is faster than it; an equal or slower clip keeps its own rate.
    const forced=input.fps===undefined?undefined:(await probeOnce()).averageRate>input.fps?input.fps:undefined;
    if(!region&&!forced&&await inspectSource(file,signal))return assetView(source);
    const earlier=await readyAsset(db,workspaceId,input.projectId,hash.sha256,clean,forced);
    if(earlier)return region?{...earlier,cleaned:true}:earlier;
    const sourceProbe=await probeOnce(),fps=forced??readyFrameRate(sourceProbe.averageRate),tools=await videoExtensionReadiness();
    if(tools.state!=="ready")throw new HttpError(503,"The server cannot make clips ready right now.");
    const scratch=path.join(store.root,".video-prepare");
    await mkdir(scratch,{recursive:true});
    if((await lstat(scratch)).isSymbolicLink())throw new HttpError(422,"This clip could not be made ready.");
    const root=await realpath(scratch),dir=await mkdtemp(path.join(root,"prepare-")),target=path.join(dir,"ready.mp4");
    let saved:Awaited<ReturnType<DiskStore["put"]>>|undefined;
    try{
      const filter=`${region?`crop=${region.width}:${region.height}:${region.x}:${region.y},`:""}setpts=PTS-STARTPTS,fps=${fps},setsar=1,format=yuv420p`;
      const args=["-hide_banner","-loglevel","error","-nostdin","-y","-protocol_whitelist","file,pipe","-start_at_zero","-i",file,
        "-map","0:v:0",...(sourceProbe.audio?["-map","0:a:0"]:[]),"-vf",filter,"-fps_mode","cfr","-c:v","libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p",
        ...(sourceProbe.audio?["-c:a","aac","-b:a","128k","-ar","48000","-ac","2"]:["-an"]),
        // ffmpeg autorotates the source, setsar=1 gives square pixels, and only the first audio stream is kept.
        "-map_metadata","-1","-map_chapters","-1","-movflags","+faststart",
        // make_zero would shift the first video frame by the AAC encoder delay; auto keeps it at zero.
        "-avoid_negative_ts","auto","-fs",String(store.maxBytes+1),target];
      try{await execute(process.env.FFMPEG_PATH??"ffmpeg",args,{windowsHide:true,maxBuffer:ENCODE_MAX_OUTPUT_BYTES,signal});}
      catch(error){
        if(signal.aborted)aborted(signal);
        const failure=error as NodeJS.ErrnoException;
        if(failure.code==="ENOENT"||failure.code==="EACCES")throw new HttpError(503,"The server cannot make clips ready right now.");
        unreadable();
      }
      const facts=await inspectNormalizedVideo(target,signal).catch(error=>{
        if(signal.aborted)aborted(signal);
        if(error instanceof VideoExtensionToolUnavailableError)throw new HttpError(503,"The server cannot make clips ready right now.");
        throw new HttpError(422,"This clip could not be made ready. It may be too long or damaged.");
      });
      // The crop keeps the picture; what is painted on the picture is taken out before any tool runs.
      const overlay=region?await overlayFree(db,store,workspaceId,hash.sha256,{cropped:target,painted:path.join(dir,"painted.mp4"),facts,fps,audio:sourceProbe.audio,signal}):undefined;
      // Never publish/cache a cropped-but-still-dirty asset under a clean receipt.
      // Partial windows remain in the bounded overlay cache for an explicit later retry.
      if(overlay&&(overlay.state==="unavailable"||overlay.state==="incomplete")){
        throw new HttpError(422,overlay.state==="incomplete"
          ?"Overlay removal is incomplete. The video has not been submitted. Try again to continue cleaning the remaining sections."
          :"Overlay removal is unavailable. The video has not been submitted. Check that the local video worker is ready.");
      }
      const delivered=overlay?.file??target,finalFacts=overlay?.facts??facts;
      const encoded=await fileSha256AndBytes(delivered).catch(()=>{throw new HttpError(422,"This clip could not be made ready.");});
      const unchanged=await fileSha256AndBytes(file).catch(()=>{throw new HttpError(422,"The source clip changed while it was made ready.");});
      if(unchanged.sha256!==hash.sha256)throw new HttpError(422,"The source clip changed while it was made ready.");
      saved=await store.put(workspaceId,createReadStream(delivered)).catch(()=>{throw new HttpError(422,"The ready clip could not be stored.");});
      if(saved.sha256!==encoded.sha256||saved.bytes!==encoded.bytes)throw new HttpError(422,"The ready clip changed while it was stored.");
      const metadata={validationVersion:1,videoPrepare:{version:1,sourceAssetId:source.id,sourceSha256:hash.sha256,sourceBytes:hash.bytes,
        ...(forced?{fps:forced}:{}),
        ...(region?{clean:true,cleanVersion:CLEAN_REGION_VERSION,region:{x:region.x,y:region.y,width:region.width,height:region.height,aspect:region.aspect},
          ...(overlay?{overlay:{state:overlay.state,...(overlay.coverage!==undefined?{coverage:overlay.coverage}:{}),...(overlay.regions?.length?{regions:overlay.regions}:{})}}:{})}:{}),output:finalFacts}},
        suffix=region?"(clean)":forced?`(ready ${forced} fps)`:"(ready)",assetId=newId();
      let row:VideoAssetRow|undefined;
      try{
        row=await db.transaction(async client=>{
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`video-prepare:${workspaceId}/${input.projectId}/${hash.sha256}`]);
          if(!(await client.query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2",[workspaceId,input.projectId])).rows.length)throw new HttpError(404,"Project not found");
          const existing=await readyAsset(client,workspaceId,input.projectId,hash.sha256,clean,forced);
          if(existing)return existing;
          return (await client.query(`INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,'video','video/mp4',$5,$6,$7,$8,$9,$10) RETURNING ${assetColumns}`,[assetId,workspaceId,input.projectId,`${String(source.name).slice(0,200)} ${suffix}`,saved!.key,saved!.sha256,saved!.bytes,createdBy,source.id,JSON.stringify(metadata)])).rows[0] as VideoAssetRow;
        });
      }catch(error){await store.remove(workspaceId,saved.key).catch(()=>{});throw error;}
      if(row.id!==assetId)await store.remove(workspaceId,saved.key).catch(()=>{});
      return region?{...row,cleaned:true}:row;
    }finally{await rm(dir,{recursive:true,force:true}).catch(()=>{});}
  });
}

/** The trim route's entry: a pooled connection, and the signed-in person as the copy's owner. */
export async function prepareVideoSource(pool:Pool,store:DiskStore,workspaceId:string,userId:string,input:{projectId:string;assetId:string;clean?:boolean;fps?:number},cancel?:AbortSignal):Promise<PreparedVideoSource>{
  return prepareVideoAsset({query:(text,values)=>pool.query(text,values),transaction:work=>transaction(pool,work)},store,workspaceId,{...input,createdBy:userId},cancel);
}

export type CleanedRunSource={asset:ResolvedRunAsset;snapshot:CleanSourceSnapshot};

/** The source a tool compiles: a clean copy of the reference clip when there is one.
 *  Every tool that takes a reference clip runs on a clean copy, made once per source bytes.
 *  A clip with no overlay region stays itself, and a machine that cannot make the copy right
 *  now may use the original only for a caller that has not required cleaning.
 *  Detected but unremoved overlays are always refused. Replacement requires this
 *  check, including temporary service failures. */
export async function admitCleanVideoSource(client:PoolClient,store:DiskStore,workspaceId:string,source:ResolvedRunAsset,fps?:number,required=false):Promise<CleanedRunSource|undefined>{
  if(!source.project_id||!source.storage_key||source.media_type!=="video")return undefined;
  let prepared:PreparedVideoSource;
  try{
    prepared=await prepareVideoAsset({query:(text,values)=>client.query(text,values),transaction:async work=>work(client)},store,workspaceId,{projectId:source.project_id,assetId:source.id,clean:true,...(fps===undefined?{}:{fps})});
  }catch(error){
    if(!required&&error instanceof HttpError&&(error.statusCode===429||error.statusCode>=500))return undefined;
    throw error;
  }
  if(!prepared.cleaned)return undefined;
  const clean=(await client.query(`SELECT ${assetColumns},storage_key FROM assets WHERE workspace_id=$1 AND id=$2`,[workspaceId,prepared.id])).rows[0] as SourceAssetRow|undefined;
  if(!clean?.storage_key)return undefined;
  const receipt=(clean.metadata?.videoPrepare??{}) as {region?:CleanSourceSnapshot["region"];output?:{width?:number;height?:number}};
  if(!receipt.region)return undefined;
  return {asset:{...source,id:clean.id,parent_id:clean.parent_id,sha256:clean.sha256,storage_key:clean.storage_key,metadata:clean.metadata},
    snapshot:{validationVersion:1,contract:"clean_source_v1",sourceAssetId:source.id,sourceSha256:source.sha256,cleanedAssetId:clean.id,cleanedSha256:clean.sha256,
      width:Number(receipt.output?.width??receipt.region.width),height:Number(receipt.output?.height??receipt.region.height),region:receipt.region}};
}

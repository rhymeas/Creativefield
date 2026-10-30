import {createReadStream} from "node:fs";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import type {PoolClient} from "pg";
import {HttpError} from "./auth";
import {newId} from "./crypto";
import type {ResolvedRunAsset} from "./element-inputs";
import type {FpsPrepareSnapshot} from "../src/capabilities/types";
import type {DiskStore} from "./storage";
import {fileSha256,inspectGeneralVideo,inspectMaskVideo,targetFrames,targetGeometry,transcodeNormalized,withMaskInspection,type GeneralVideo} from "./masked-media";

/** Ordinary camera footage is resampled onto the 16 fps VACE envelope before the graph
 *  compiles, so one pass keeps five seconds of a 24 or 30 fps clip instead of the first
 *  2.7 or 3.4 seconds. Mirrors the masked-edit pair normalization in masked-media.ts. */
export const FPS_PREPARE_CONTRACT="source_16fps_v1" as const;
export const FPS_PREPARE_FPS=16 as const;
export const FPS_PREPARE_MAX_FRAMES=81;
export const FPS_PREPARE_MAX_SECONDS=FPS_PREPARE_MAX_FRAMES/FPS_PREPARE_FPS;

/** The one line a run carries when the clip is longer than a single pass. */
export function clipCutNotice(seconds:number):string|undefined{
  if(!(seconds>FPS_PREPARE_MAX_SECONDS))return undefined;
  const shown=Math.round(seconds*10)/10;
  return `Your clip is ${shown} s; this tool makes up to 5 s, so the first 5 s were used.`;
}

/** Same source bytes and same envelope parameters share one derived asset. */
export function fpsPrepareKey(sourceSha256:string,width:number,height:number,frames:number):string{
  return createHash("sha256").update(`${FPS_PREPARE_CONTRACT}|${sourceSha256}|${width}x${height}|${frames}`).digest("hex");
}

export type PreparedFpsVideo={path:string;width:number;height:number;frames:number;timingDigest:string;seconds:number;notice?:string;cleanup:()=>Promise<void>};

/** Resample one ordinary clip to 16 fps and 4n+1 frames from its duration (17 to 81). */
export async function prepareFpsVideo(sourceFile:string,source?:GeneralVideo):Promise<PreparedFpsVideo>{
  return withMaskInspection(async()=>{
    const inspected=source??await inspectGeneralVideo(sourceFile);
    const {width,height}=targetGeometry(inspected.width,inspected.height),frames=targetFrames(inspected.duration);
    const dir=await mkdtemp(join(tmpdir(),"comfyfield-fps-prepare-"));
    const cleanup=async()=>{await rm(dir,{recursive:true,force:true}).catch(()=>{});};
    try{
      const path=join(dir,"source-16fps.mp4");
      await transcodeNormalized(sourceFile,path,width,height,frames,false,"The clip could not be prepared at 16 fps");
      const prepared=await inspectMaskVideo(path);
      if(prepared.width!==width||prepared.height!==height||prepared.frames!==frames)throw new HttpError(422,"The clip could not be prepared at 16 fps");
      return {path,width,height,frames,timingDigest:prepared.timingDigest,seconds:inspected.duration,notice:clipCutNotice(inspected.duration),cleanup};
    }catch(error){await cleanup();throw error;}
  });
}

export type PreparedFpsSource={asset:ResolvedRunAsset;snapshot:FpsPrepareSnapshot};

/** Use the upload when it already fits the envelope; otherwise derive, store and reuse
 *  one 16 fps copy per source bytes and envelope parameters. */
export async function admitPreparedFpsSource(client:PoolClient,store:DiskStore,workspaceId:string,source:ResolvedRunAsset):Promise<PreparedFpsSource|undefined>{
  if(!source.project_id||!source.storage_key||source.media_type!=="video")throw new HttpError(422,"The source video is unavailable");
  const sourceFile=await store.file(workspaceId,source.storage_key);
  if(await fileSha256(sourceFile)!==source.sha256)throw new HttpError(422,"The source video changed since upload; upload it again");
  try{
    await withMaskInspection(()=>inspectMaskVideo(sourceFile));
    return undefined;
  }catch(error){
    if(!(error instanceof HttpError&&error.statusCode===422))throw error;
  }
  const inspected=await withMaskInspection(()=>inspectGeneralVideo(sourceFile));
  const {width,height}=targetGeometry(inspected.width,inspected.height),frames=targetFrames(inspected.duration);
  const key=fpsPrepareKey(source.sha256,width,height,frames),projectId=source.project_id;
  const own=(await client.query("SELECT created_by,name FROM assets WHERE workspace_id=$1 AND id=$2 AND project_id=$3",[workspaceId,source.id,projectId])).rows[0];
  if(!own)throw new HttpError(422,"The source video is unavailable");
  const existing=(await client.query("SELECT id,sha256,storage_key,metadata FROM assets WHERE workspace_id=$1 AND project_id=$2 AND parent_id=$3 AND media_type='video' AND metadata->>'fpsPrepareKey'=$4 ORDER BY created_at DESC LIMIT 1",[workspaceId,projectId,source.id,key])).rows[0];
  if(existing?.storage_key&&existing.sha256){
    try{
      if(await fileSha256(await store.file(workspaceId,existing.storage_key))===existing.sha256){
        const receipt=existing.metadata?.fpsPrepare as {timingDigest?:unknown}|undefined,timingDigest=typeof receipt?.timingDigest==="string"?receipt.timingDigest:"";
        if(/^[a-f0-9]{64}$/.test(timingDigest))return {asset:{...source,id:existing.id,parent_id:source.id,sha256:existing.sha256,storage_key:existing.storage_key,metadata:{fpsPrepareKey:key}},snapshot:{validationVersion:1,contract:FPS_PREPARE_CONTRACT,sourceAssetId:source.id,sourceSha256:source.sha256,preparedAssetId:existing.id,preparedSha256:existing.sha256,width,height,fps:FPS_PREPARE_FPS,frames,timingDigest,...(clipCutNotice(inspected.duration)?{notice:clipCutNotice(inspected.duration)}:{})}};
      }
    }catch{/* A missing derived file is made again below. */}
  }
  const prepared=await prepareFpsVideo(sourceFile,inspected),assetId=newId();
  let saved:{key:string;bytes:number;sha256:string}|undefined,inserted=false;
  try{
    saved=await store.put(workspaceId,createReadStream(prepared.path),assetId);
    const snapshot:FpsPrepareSnapshot={validationVersion:1,contract:FPS_PREPARE_CONTRACT,sourceAssetId:source.id,sourceSha256:source.sha256,preparedAssetId:assetId,preparedSha256:saved.sha256,width,height,fps:FPS_PREPARE_FPS,frames,timingDigest:prepared.timingDigest,...(prepared.notice?{notice:prepared.notice}:{})};
    await client.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,'video','video/mp4',$5,$6,$7,$8,$9,$10)",[assetId,workspaceId,projectId,`${String(own.name??"video").slice(0,180)} (16 fps)`,saved.key,saved.sha256,saved.bytes,own.created_by,source.id,JSON.stringify({fpsPrepare:snapshot,fpsPrepareKey:key})]);
    inserted=true;
    return {asset:{...source,id:assetId,parent_id:source.id,sha256:saved.sha256,storage_key:saved.key,metadata:{fpsPrepareKey:key}},snapshot};
  }catch(error){
    if(saved&&!inserted)await store.remove(workspaceId,saved.key).catch(()=>{});
    throw error;
  }finally{
    await prepared.cleanup();
  }
}

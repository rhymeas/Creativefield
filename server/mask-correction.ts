import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,rm} from "node:fs/promises";
import {createReadStream} from "node:fs";
import path from "node:path";
import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {HttpError,member} from "./auth";
import {transaction} from "./db";
import type {DiskStore} from "./storage";
import {admitAlignedMask} from "./aligned-mask-admission";
import {fileSha256,inspectMaskCoverage,validateMaskPair,withMaskInspection} from "./masked-media";
import {MAX_MASK_PATCHES,validMaskPatch,type MaskPatch} from "../src/team/video-mask/correction";

const execute=promisify(execFile),columns="id,project_id,name,media_type,content_type,sha256,bytes,parent_id,created_at,metadata";
export const maskCorrectionBody=z.object({requestId:z.uuid(),expectedSha256:z.string().regex(/^[a-f0-9]{64}$/),patches:z.array(z.object({start:z.number().int().min(0).max(80),end:z.number().int().min(0).max(80),x:z.number().int().min(0).max(4096),y:z.number().int().min(0).max(4096),width:z.number().int().min(1).max(4096),height:z.number().int().min(1).max(4096),mode:z.enum(["add","subtract"])}).strict()).min(1).max(MAX_MASK_PATCHES)}).strict();
export function correctionFilters(patches:MaskPatch[]){return patches.map(p=>`drawbox=x=${p.x}:y=${p.y}:w=${p.width}:h=${p.height}:color=${p.mode==="add"?"white":"black"}:t=fill:enable='between(n,${p.start},${p.end})'`).join(",");}

/** Explicit manual corrections create a new mask; no model request or original mutation. */
export async function maskCorrectionRoutes(app:FastifyInstance,pool:Pool,store:DiskStore){
  app.post("/api/v1/workspaces/:workspaceId/assets/:id/mask-corrections",async request=>{
    const {workspaceId,id}=z.object({workspaceId:z.uuid(),id:z.uuid()}).parse(request.params),user=await member(pool,request,workspaceId,"creator");
    z.object({}).strict().parse(request.query);const body=maskCorrectionBody.parse(request.body),requestHash=createHash("sha256").update(JSON.stringify({id,...body})).digest("hex");
    return transaction(pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${workspaceId}:${body.requestId}`]);
      const existing=(await client.query(`SELECT ${columns},created_by FROM assets WHERE workspace_id=$1 AND id=$2`,[workspaceId,body.requestId])).rows[0];
      if(existing){if(existing.created_by!==user.id||existing.metadata?.maskCorrection?.requestHash!==requestHash)throw new HttpError(409,"This correction identifier belongs to another request.");const {created_by,...asset}=existing;return asset;}
      const mask=(await client.query("SELECT * FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,id])).rows[0];
      if(!mask||mask.media_type!=="mask"||!mask.parent_id)throw new HttpError(404,"Mask not found.");
      if(mask.sha256!==body.expectedSha256)throw new HttpError(409,"This mask changed. Reopen it before correcting.");
      const source=(await client.query("SELECT * FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=$3",[workspaceId,mask.project_id,mask.parent_id])).rows[0];
      const admitted=await admitAlignedMask(client,store,workspaceId,mask.project_id,source,mask),g=admitted.media;
      if(body.patches.some(p=>!validMaskPatch(p,g)))throw new HttpError(422,"Keep corrections inside the clip and selected frame range.");
      const dir=await mkdtemp(path.join(store.root,"mask-correction-"));let saved:{key:string;sha256:string;bytes:number}|undefined,inserting=false;
      try{
        const output=path.join(dir,"mask.mp4"),input=await store.file(workspaceId,mask.storage_key);
        await withMaskInspection(async()=>{try{await execute(process.env.FFMPEG_PATH??"ffmpeg",["-v","error","-nostdin","-y","-noautorotate","-i",input,"-map","0:v:0","-an","-sn","-dn","-vf",correctionFilters(body.patches),"-frames:v",String(g.frames),"-c:v","libx264","-crf","0","-pix_fmt","yuv420p","-movflags","+faststart",output],{windowsHide:true,timeout:20000,maxBuffer:65536});}catch{throw new HttpError(422,"The corrected mask could not be encoded. Try fewer frame corrections.");}});
        if(await fileSha256(input)!==mask.sha256||await fileSha256(await store.file(workspaceId,source.storage_key))!==source.sha256)throw new HttpError(422,"The source or mask changed during correction. Reopen the original mask.");
        saved=await store.put(workspaceId,createReadStream(output));
        const sequence=await validateMaskPair(await store.file(workspaceId,admitted.source.storage_key!),await store.file(workspaceId,saved.key),{sourceAssetId:source.id,sourceSha256:admitted.source.sha256,maskSha256:saved.sha256});
        const coverage=await inspectMaskCoverage(output,g,saved.sha256);
        const metadata={maskSequence:{...sequence,sourceSha256:source.sha256},maskCoverage:coverage,maskCorrection:{version:1,requestHash,sourceMaskId:mask.id,sourceMaskSha256:mask.sha256,sourceAssetId:source.id,sourceSha256:source.sha256,reviewedBy:user.id,reviewedAt:new Date().toISOString(),patches:body.patches},...(admitted.normalization?{maskNormalization:{...admitted.normalization,normalizedMaskAssetId:body.requestId,normalizedMaskSha256:saved.sha256}}:{})};
        inserting=true;
        return (await client.query(`INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,'mask','video/mp4',$5,$6,$7,$8,$9,$10) RETURNING ${columns}`,[body.requestId,workspaceId,mask.project_id,`${String(mask.name).slice(0,210)} (corrected)`,saved.key,saved.sha256,saved.bytes,user.id,source.id,JSON.stringify(metadata)])).rows[0];
      }catch(error){if(saved&&!inserting)await store.remove(workspaceId,saved.key).catch(()=>{});throw error;}finally{await rm(dir,{recursive:true,force:true});}
    });
  });
}

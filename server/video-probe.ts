import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import path from "node:path";
import {Readable} from "node:stream";
import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {member,HttpError} from "./auth";
import {transaction} from "./db";
import {newId} from "./crypto";
import type {DiskStore} from "./storage";
import {fileSha256AndBytes,inspectNormalizedVideo} from "./video-extension-media";
import {VIDEO_PROBE_FRAMES} from "../src/capabilities/replace-video-probe";
const execute=promisify(execFile);

/** CPU-only, exact 24fps preparation before bounded overlay cleaning/inference. */
export async function videoProbeSourceRoutes(app:FastifyInstance,pool:Pool,store:DiskStore){
  app.post("/api/v1/workspaces/:workspaceId/video-frame-sources",async request=>{
    const {workspaceId}=z.object({workspaceId:z.uuid()}).parse(request.params),user=await member(pool,request,workspaceId,"creator");
    const body=z.object({projectId:z.uuid(),assetId:z.uuid()}).strict().parse(request.body);
    return transaction(pool,async client=>{
      const source=(await client.query("SELECT * FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=$3",[workspaceId,body.projectId,body.assetId])).rows[0];
      if(!source||source.media_type!=="video")throw new HttpError(404,"Source video not found");
      const file=await store.file(workspaceId,source.storage_key),bytes=await fileSha256AndBytes(file);
      if(bytes.sha256!==source.sha256||bytes.bytes!==Number(source.bytes))throw new HttpError(422,"The source video changed");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`video-probe-source:${workspaceId}:${source.id}:${source.sha256}`]);
      const cached=(await client.query("SELECT * FROM assets WHERE workspace_id=$1 AND project_id=$2 AND metadata->'videoProbeSource'->>'version'='1' AND metadata->'videoProbeSource'->>'sourceAssetId'=$3 AND metadata->'videoProbeSource'->>'sourceSha256'=$4 LIMIT 1",[workspaceId,body.projectId,source.id,source.sha256])).rows[0];
      if(cached){const disk=await fileSha256AndBytes(await store.file(workspaceId,cached.storage_key));if(disk.sha256===cached.sha256&&disk.bytes===Number(cached.bytes))return cached;}
      const scratch=await mkdtemp(path.join(store.root,"video-probe-")),target=path.join(scratch,"source.mp4");let saved:{key:string;sha256:string;bytes:number}|undefined;
      try{
        await execute(process.env.FFMPEG_PATH??"ffmpeg",["-v","error","-nostdin","-protocol_whitelist","file,pipe","-i",file,"-vf","fps=24","-frames:v",String(VIDEO_PROBE_FRAMES),"-an","-c:v","libx264","-preset","fast","-crf","18","-pix_fmt","yuv420p","-movflags","+faststart",target],{windowsHide:true,timeout:30000,maxBuffer:1024*1024});
        const facts=await inspectNormalizedVideo(target);
        if(facts.frameCount!==VIDEO_PROBE_FRAMES||facts.frameRate.numerator!==24*facts.frameRate.denominator)throw new HttpError(422,"The clip has fewer than five usable frames");
        saved=await store.put(workspaceId,Readable.from(await readFile(target)));
        const metadata={videoProbeSource:{version:1,sourceAssetId:source.id,sourceSha256:source.sha256,startFrame:0,frames:VIDEO_PROBE_FRAMES,fps:24},...facts};
        return (await client.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,'Video frame test source','video','video/mp4',$4,$5,$6,$7,$8,$9) RETURNING *",[newId(),workspaceId,body.projectId,saved.key,saved.sha256,saved.bytes,user.id,source.id,JSON.stringify(metadata)])).rows[0];
      }catch(error){if(saved)await store.remove(workspaceId,saved.key).catch(()=>{});throw error;}
      finally{const root=path.resolve(store.root),resolved=path.resolve(scratch);if(path.dirname(resolved)===root&&path.basename(resolved).startsWith("video-probe-"))await rm(resolved,{recursive:true,force:true});}
    });
  });
}

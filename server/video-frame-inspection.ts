import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createHash} from "node:crypto";
import {mkdir,mkdtemp,readFile,rm} from "node:fs/promises";
import {Readable} from "node:stream";
import path from "node:path";
import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {member,HttpError} from "./auth";
import {transaction} from "./db";
import {newId} from "./crypto";
import type {DiskStore} from "./storage";
import {fileSha256AndBytes,inspectNormalizedVideo} from "./video-extension-media";
import {secondsToWanFrames} from "../src/workflow/build";

const execute=promisify(execFile),version=1;
const digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
export function rgbDifference(a:Buffer,b:Buffer){
  if(!a.length||a.length!==b.length)throw new Error("Aligned RGB samples are required");
  let sum=0,max=0;for(let i=0;i<a.length;i++){const delta=Math.abs(a[i]-b[i]);sum+=delta;max=Math.max(max,delta);}
  return {meanAbsoluteRgb8:sum/a.length,maxChannelDelta8:max};
}
export function inspectionFrameIndices(count:number){
  if(!Number.isInteger(count)||count<2||count>81)throw new Error("Inspect 2–81 frames");
  return [...new Set(Array.from({length:Math.min(8,count)},(_,i)=>Math.round(i*(count-1)/(Math.min(8,count)-1))))];
}
async function ffmpeg(args:string[],_binary=false,maxBuffer=24*1024*1024){
  try{return (await execute(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-loglevel","error","-nostdin",...args],{encoding:"buffer",windowsHide:true,timeout:60000,maxBuffer})).stdout;}
  catch{throw new HttpError(422,"Frame inspection could not decode this media with the installed FFmpeg");}
}

export async function extractVideoFrameInspection(filename:string,scratch:string,expectedFrames:number,endpoints:{first:string;last:string}){
  const facts=await inspectNormalizedVideo(filename);
  if(facts.frameCount!==expectedFrames||facts.frameRate.numerator/facts.frameRate.denominator!==16||facts.width>832||facts.height>832||facts.width*facts.height>399360)throw new HttpError(422,"FLF inspection requires the frozen 16 FPS frame count and supported output dimensions");
  const width=256,height=Math.max(2,2*Math.round(width*facts.height/facts.width/2)),stride=width*height*3;
  const raw=await ffmpeg(["-protocol_whitelist","file,pipe","-i",filename,"-map","0:v:0","-vf",`scale=${width}:${height}:flags=area`,"-fps_mode","passthrough","-f","rawvideo","-pix_fmt","rgb24","pipe:1"],true,stride*expectedFrames+1024) as Buffer;
  if(raw.length!==stride*expectedFrames)throw new HttpError(422,"Decoded frame samples do not match the frozen frame count");
  const samples=Array.from({length:expectedFrames},(_,i)=>raw.subarray(i*stride,(i+1)*stride));
  const adjacent=samples.slice(1).map((sample,i)=>({from:i,to:i+1,...rgbDifference(samples[i],sample)}));
  const hashes=String(await ffmpeg(["-protocol_whitelist","file,pipe","-i",filename,"-map","0:v:0","-fps_mode","passthrough","-f","framemd5","pipe:1"])).split(/\r?\n/).filter(line=>line&&!line.startsWith("#")).map(line=>line.split(",").at(-1)!.trim());
  if(hashes.length!==expectedFrames)throw new HttpError(422,"Decoded full-frame hashes are incomplete");
  const duplicatePairs=hashes.slice(1).flatMap((hash,i)=>hash===hashes[i]?[{from:i,to:i+1}]:[]);
  const reference=async(file:string)=>await ffmpeg(["-protocol_whitelist","file,pipe","-i",file,"-frames:v","1","-vf",`scale=${facts.width}:${facts.height}:force_original_aspect_ratio=increase:flags=bilinear,crop=${facts.width}:${facts.height},scale=${width}:${height}:flags=area`,"-f","rawvideo","-pix_fmt","rgb24","pipe:1"],true,stride+1024) as Buffer;
  const first=await reference(endpoints.first),last=await reference(endpoints.last);
  const indices=inspectionFrameIndices(expectedFrames),selection=indices.map(i=>`eq(n\\,${i})`).join("+");
  await ffmpeg(["-protocol_whitelist","file,pipe","-i",filename,"-vf",`select=${selection}`,"-fps_mode","vfr","-start_number","0",path.join(scratch,"frame-%02d.png")]);
  const images=[];for(const [ordinal,index]of indices.entries())images.push({index,bytes:await readFile(path.join(scratch,`frame-${String(ordinal).padStart(2,"0")}.png`))});
  return {facts,images,measurement:{version,space:"decoded_rgb8",sampleWidth:width,sampleHeight:height,referenceFit:"centered_bilinear_cover_then_area",firstSourceDelta:rgbDifference(samples[0],first),lastSourceDelta:rgbDifference(samples.at(-1)!,last),adjacent,duplicatePairs,decodedFrameMd5:hashes}};
}

export async function videoFrameInspectionRoutes(app:FastifyInstance,pool:Pool,store:DiskStore){
  const base="/api/v1/workspaces/:workspaceId/runs/:id/frames",params=z.object({workspaceId:z.uuid(),id:z.uuid()});
  app.get(base,async request=>{
    const {workspaceId,id}=params.parse(request.params);await member(pool,request,workspaceId);
    const row=(await pool.query("SELECT result FROM video_frame_inspections WHERE workspace_id=$1 AND run_id=$2 AND inspection_version=$3",[workspaceId,id,version])).rows[0];
    if(!row){if(!(await pool.query("SELECT id FROM runs WHERE workspace_id=$1 AND id=$2",[workspaceId,id])).rowCount)throw new HttpError(404,"Run not found");return null;}return row.result;
  });
  app.post(base,async request=>{
    const {workspaceId,id}=params.parse(request.params),user=await member(pool,request,workspaceId,"creator");z.object({}).strict().parse(request.body??{});
    const created:string[]=[];
    try{return await transaction(pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`frame-inspection:${workspaceId}/${id}/${version}`]);
      const old=(await client.query("SELECT result FROM video_frame_inspections WHERE workspace_id=$1 AND run_id=$2 AND inspection_version=$3",[workspaceId,id,version])).rows[0];if(old)return old.result;
      const run=(await client.query("SELECT * FROM runs WHERE workspace_id=$1 AND id=$2",[workspaceId,id])).rows[0];
      if(!run)throw new HttpError(404,"Run not found");
      if(run.capability_id!=="wan22-flf2v-14b"||run.state!=="succeeded"||run.output_ids?.length!==1)throw new HttpError(422,"Inspect a successful single-video first/last-frame run");
      const source=(await client.query("SELECT * FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND media_type='video'",[workspaceId,run.project_id,run.output_ids[0]])).rows[0];if(!source)throw new HttpError(422,"Published video is unavailable");
      const inputs=(await client.query("SELECT i.role,a.* FROM run_inputs i JOIN assets a ON a.workspace_id=i.workspace_id AND a.id=i.asset_id WHERE i.workspace_id=$1 AND i.run_id=$2 AND i.role IN ('start_image','end_image') AND(a.project_id=$3 OR a.project_id IS NULL)",[workspaceId,id,run.project_id])).rows;
      const input=async(role:string)=>{const a=inputs.find(a=>a.role===role);if(!a||a.media_type!=="image")throw new HttpError(422,"Frozen endpoint image is unavailable");const file=await store.file(workspaceId,a.storage_key);if((await fileSha256AndBytes(file)).sha256!==a.sha256)throw new HttpError(422,"Endpoint image changed since publication");return file;};
      const filename=await store.file(workspaceId,source.storage_key);if((await fileSha256AndBytes(filename)).sha256!==source.sha256)throw new HttpError(422,"Published video changed since publication");
      const expected=secondsToWanFrames(Number(run.invocation.controls.length),16),root=path.resolve(store.root,".frame-inspection");await mkdir(root,{recursive:true});
      const scratch=await mkdtemp(path.join(root,"job-"));
      try{
        const extracted=await extractVideoFrameInspection(filename,scratch,expected,{first:await input("start_image"),last:await input("end_image")});
        if((await fileSha256AndBytes(filename)).sha256!==source.sha256)throw new HttpError(422,"Published video changed during inspection");
        const frames=[];
        for(const image of extracted.images){
          const saved=await store.put(workspaceId,Readable.from(image.bytes));created.push(saved.key);const assetId=newId();
          await client.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,'image','image/png',$5,$6,$7,$8,$9,$10)",[assetId,workspaceId,run.project_id,`frame-${image.index}.png`,saved.key,saved.sha256,saved.bytes,user.id,source.id,JSON.stringify({frameExtraction:{version,sourceAssetId:source.id,sourceSha256:source.sha256,runId:id,frameIndex:image.index,fps:16}})]);
          frames.push({index:image.index,assetId,sha256:digest(image.bytes)});
        }
        const result={version,runId:id,sourceAssetId:source.id,sourceSha256:source.sha256,firstInputAssetId:inputs.find(a=>a.role==="start_image").id,lastInputAssetId:inputs.find(a=>a.role==="end_image").id,...extracted.facts,frames,measurement:extracted.measurement};
        await client.query("INSERT INTO video_frame_inspections(workspace_id,run_id,inspection_version,source_asset_id,result,created_by) VALUES($1,$2,$3,$4,$5,$6)",[workspaceId,id,version,source.id,JSON.stringify(result),user.id]);return result;
      }finally{if(path.dirname(path.resolve(scratch))!==root||!path.basename(scratch).startsWith("job-"))throw new Error("Refusing unexpected inspection scratch cleanup");await rm(scratch,{recursive:true,force:true});}
    });}catch(e){for(const key of created)await store.remove(workspaceId,key).catch(()=>{});throw e;}
  });
}

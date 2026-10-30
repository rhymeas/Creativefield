import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createHash} from "node:crypto";
import {Readable} from "node:stream";
import sharp from "sharp";
import {z} from "zod";
import type {FastifyInstance} from "fastify";
import type {Pool,PoolClient} from "pg";
import {member,HttpError} from "./auth";
import {transaction} from "./db";
import {newId} from "./crypto";
import type {DiskStore} from "./storage";
import {fileSha256AndBytes,inspectNormalizedVideo} from "./video-extension-media";
import {canonical,prepareInvocation,enqueuePreparedRun} from "./run-submission";
import type {CapabilityBundle} from "../src/capabilities/types";
import {SCENE_ANCHOR_ID,SCENE_ANCHOR_FLUX_ID,sceneAnchorPrompt,sceneAnchorFluxPrompt,type SceneAnchorReview} from "../src/capabilities/scene-anchor";

const execute=promisify(execFile);
const createSchema=z.object({projectId:z.uuid(),workerId:z.uuid(),videoAssetId:z.uuid(),referenceIds:z.array(z.uuid()).length(2),variant:z.enum(["qwen","flux"]).default("qwen"),frameIndex:z.number().int().min(0).max(6000).default(0),prompt:z.string().max(2000).default(""),requestKey:z.uuid()}).strict();
const hash=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");

async function frame(client:PoolClient,store:DiskStore,workspace:string,user:string,body:z.infer<typeof createSchema>,created:string[]){
  const source=(await client.query("SELECT id,project_id,media_type,storage_key,sha256,bytes FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=$3",[workspace,body.projectId,body.videoAssetId])).rows[0];
  if(!source||source.media_type!=="video")throw new HttpError(404,"Source video not found");
  const file=await store.file(workspace,source.storage_key),bytes=await fileSha256AndBytes(file);
  if(bytes.sha256!==source.sha256||bytes.bytes!==Number(source.bytes))throw new HttpError(422,"The source video changed");
  const facts=await inspectNormalizedVideo(file);
  if(body.frameIndex>=facts.frameCount||facts.width*facts.height>4194304||facts.width>2048||facts.height>2048)throw new HttpError(422,"Choose an available frame from a video at up to 2048 pixels per side");
  const existing=(await client.query("SELECT id FROM assets WHERE workspace_id=$1 AND project_id=$2 AND metadata->'replaceAnchorFrame'->>'sourceSha256'=$3 AND metadata->'replaceAnchorFrame'->>'frameIndex'=$4 AND metadata->'replaceAnchorFrame'->>'sourceAssetId'=$5 LIMIT 1",[workspace,body.projectId,source.sha256,String(body.frameIndex),source.id])).rows[0];
  if(existing)return existing.id as string;
  let png:Buffer;
  try{png=(await execute(process.env.FFMPEG_PATH??"ffmpeg",["-v","error","-nostdin","-protocol_whitelist","file,pipe","-i",file,"-vf",`select=eq(n\\,${body.frameIndex})`,"-frames:v","1","-f","image2pipe","-vcodec","png","pipe:1"],{windowsHide:true,encoding:"buffer",timeout:30000,maxBuffer:32*1024*1024})).stdout;}
  catch{throw new HttpError(422,"The source frame could not be extracted");}
  const size=await sharp(png,{limitInputPixels:4194304}).metadata();
  if(size.width!==facts.width||size.height!==facts.height)throw new HttpError(422,"Source frame dimensions changed");
  const saved=await store.put(workspace,Readable.from(png));created.push(saved.key);
  const id=newId(),metadata={replaceAnchorFrame:{version:1,sourceAssetId:source.id,sourceSha256:source.sha256,frameIndex:body.frameIndex,width:size.width,height:size.height}};
  await client.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,'Scene source frame','image','image/png',$4,$5,$6,$7,$8,$9)",[id,workspace,body.projectId,saved.key,saved.sha256,saved.bytes,user,source.id,JSON.stringify(metadata)]);
  return id;
}

/** Compute approval against current immutable media bytes and exact run inputs. */
export async function anchorReview(client:Pick<PoolClient,"query">,workspace:string,runId:string):Promise<SceneAnchorReview>{
  const run=(await client.query("SELECT * FROM runs WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL",[workspace,runId])).rows[0];
  if(!run||![SCENE_ANCHOR_ID,SCENE_ANCHOR_FLUX_ID].includes(run.capability_id))throw new HttpError(404,"Scene frame not found");
  const inputs=run.invocation.inputs,ids=[inputs.source_image,inputs.reference_image,inputs.reference_image_2,...run.output_ids];
  const assets=(await client.query("SELECT id,sha256,metadata,project_id FROM assets WHERE workspace_id=$1 AND id=ANY($2::uuid[])",[workspace,ids])).rows;
  const source=assets.find(a=>a.id===inputs.source_image),origin=source?.metadata?.replaceAnchorFrame;
  if(!source||!origin||assets.some(a=>a.project_id!==null&&a.project_id!==run.project_id))throw new HttpError(422,"The scene frame provenance is unavailable");
  const result:SceneAnchorReview={runId,variant:run.capability_id===SCENE_ANCHOR_FLUX_ID?"flux":"qwen",state:"working",sourceVideoId:origin.sourceAssetId,sourceFrameId:source.id,referenceIds:[inputs.reference_image,inputs.reference_image_2]};
  if(["failed","canceled","cancelled"].includes(run.state))return {...result,state:"failed",error:run.error??"Scene frame creation stopped"};
  if(run.state!=="succeeded")return result;
  const candidate=assets.find(a=>a.id===run.output_ids[0]);
  if(!candidate||result.referenceIds.some(id=>!assets.some(a=>a.id===id)))throw new HttpError(422,"The scene frame or its references are unavailable");
  const video=(await client.query("SELECT sha256 FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=$3",[workspace,run.project_id,origin.sourceAssetId])).rows[0];
  if(video?.sha256!==origin.sourceSha256)throw new HttpError(409,"The source video changed; create a new scene frame");
  const digest=hash({runId,inputs,controls:run.invocation.controls,version:run.capability_version,origin,assets:ids.map(id=>({id,sha256:assets.find(a=>a.id===id)?.sha256}))});
  const review=(await client.query("SELECT context_digest,decision FROM replace_anchor_reviews WHERE workspace_id=$1 AND run_id=$2",[workspace,runId])).rows[0];
  return {...result,state:review?.context_digest===digest?review.decision:"ready",candidateId:candidate.id,contextDigest:digest};
}

export async function replaceAnchorRoutes(app:FastifyInstance,pool:Pool,store:DiskStore,catalogue:CapabilityBundle[]){
  const base="/api/v1/workspaces/:workspaceId/replace-anchors",params=z.object({workspaceId:z.uuid(),runId:z.uuid()});
  app.post(base,async request=>{
    const {workspaceId}=z.object({workspaceId:z.uuid()}).parse(request.params),user=await member(pool,request,workspaceId,"creator"),body=createSchema.parse(request.body);
    const {variant,...legacyBody}=body;
    const created:string[]=[],key=`replace-anchor:${body.requestKey}`,requestHash=hash(variant==="qwen"?legacyBody:body);
    try{return await transaction(pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[workspaceId+key]);
      const prior=(await client.query("SELECT id,request_hash FROM runs WHERE workspace_id=$1 AND idempotency_key=$2",[workspaceId,key])).rows[0];
      if(prior){if(prior.request_hash!==requestHash)throw new HttpError(409,"This scene request key belongs to different inputs");return anchorReview(client,workspaceId,prior.id);}
      const frameId=await frame(client,store,workspaceId,user.id,body,created);
      const capabilityId=body.variant==="flux"?SCENE_ANCHOR_FLUX_ID:SCENE_ANCHOR_ID;
      const pack=catalogue.find(b=>b.manifest.id===capabilityId);if(!pack)throw new HttpError(422,"The scene frame workflow is unavailable");
      const prepared=await prepareInvocation(client,catalogue,workspaceId,{projectId:body.projectId,workerId:body.workerId,capabilityId,version:pack.manifest.version,routeId:"local",idempotencyKey:key,inputs:{source_image:frameId,reference_image:body.referenceIds[0],reference_image_2:body.referenceIds[1]},controls:{prompt:body.variant==="flux"?sceneAnchorFluxPrompt(body.prompt):sceneAnchorPrompt(body.prompt)},audioPolicy:"mute"},store);
      const run=await enqueuePreparedRun(client,workspaceId,user.id,prepared,key,requestHash);
      return anchorReview(client,workspaceId,run.id);
    });}catch(error){for(const file of created)await store.remove(workspaceId,file).catch(()=>{});throw error;}
  });
  app.get(base+"/:runId",async request=>{const {workspaceId,runId}=params.parse(request.params);await member(pool,request,workspaceId);return anchorReview(pool as unknown as PoolClient,workspaceId,runId);});
  app.post(base+"/:runId/review",async request=>{
    const {workspaceId,runId}=params.parse(request.params),user=await member(pool,request,workspaceId,"creator");
    const body=z.object({decision:z.enum(["approved","rejected"]),expectedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(request.body);
    return transaction(pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[workspaceId+runId]);
      const value=await anchorReview(client,workspaceId,runId);
      if(!value.candidateId||value.contextDigest!==body.expectedDigest)throw new HttpError(409,"The scene frame changed; review it again");
      const candidate=(await client.query("SELECT storage_key,sha256 FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,value.candidateId])).rows[0];
      if(!candidate||(await fileSha256AndBytes(await store.file(workspaceId,candidate.storage_key))).sha256!==candidate.sha256)throw new HttpError(409,"The candidate image changed; create a new scene frame");
      await client.query("INSERT INTO replace_anchor_reviews(workspace_id,run_id,context_digest,decision,reviewed_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,run_id) DO UPDATE SET context_digest=excluded.context_digest,decision=excluded.decision,reviewed_by=excluded.reviewed_by,updated_at=now()",[workspaceId,runId,value.contextDigest,body.decision,user.id]);
      return {...value,state:body.decision};
    });
  });
}

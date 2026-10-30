import type {FastifyInstance} from "fastify";
import type {Pool,PoolClient} from "pg";
import {createReadStream} from "node:fs";
import {z} from "zod";
import {HttpError,member} from "./auth";
import {newId} from "./crypto";
import type {DiskStore} from "./storage";
import {fileSha256,maskReviewReceiptSchema,maskSnapshotSchema,normalizeMaskPair,sourceLinkedMaskSchema,validateMaskPair} from "./masked-media";
import {maskedEditReadiness} from "./media-tools";
import {transaction} from "./db";
import type {MaskReviewDecisionReceipt,MaskSequenceSnapshot,SourceLinkedMaskSnapshot} from "../src/capabilities/types";
import {publicColumns} from "./run-submission";

const digest=z.string().regex(/^[a-f0-9]{64}$/);
const reviewBody=z.object({decision:z.enum(["approve","reject"]),expectedSha256:digest}).strict();

function invalid(message:string):never{throw new HttpError(422,message);}
function maskSequence(receipt:SourceLinkedMaskSnapshot):MaskSequenceSnapshot{
  return {
    validationVersion:1,sourceAssetId:receipt.sourceAssetId,sourceSha256:receipt.sourceSha256,maskSha256:receipt.maskSha256,
    width:receipt.width,height:receipt.height,fps:receipt.fps,frames:receipt.frames,timingDigest:receipt.timingDigest,semantics:receipt.semantics,
  };
}
type ReviewInput={workspaceId:string;maskAssetId:string;decision:"approve"|"reject";expectedSha256:string;reviewedBy:string};

/** Transaction body exported for focused fault and idempotency tests. */
export async function reviewSourceLinkedMask(client:PoolClient,store:DiskStore,input:ReviewInput):Promise<MaskReviewDecisionReceipt>{
  const asset=(await client.query(
    "SELECT id,workspace_id,project_id,parent_id,media_type,content_type,storage_key,sha256,metadata FROM assets WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
    [input.workspaceId,input.maskAssetId],
  )).rows[0];
  if(!asset)throw new HttpError(404,"Tracked mask not found");
  if(asset.media_type!=="mask"||!asset.content_type?.startsWith("video/")||!asset.project_id||!asset.parent_id)invalid("This asset is not a reviewable tracked mask");
  const linked=sourceLinkedMaskSchema.safeParse(asset.metadata?.sourceLinkedMask);
  if(!linked.success)invalid("Tracked mask lineage is incomplete; generate the mask again");
  const receipt=linked.data;
  if(asset.sha256!==input.expectedSha256||receipt.maskSha256!==input.expectedSha256)throw new HttpError(409,"Tracked mask changed since review opened");
  if(receipt.maskAssetId!==asset.id||receipt.projectId!==asset.project_id||receipt.sourceAssetId!==asset.parent_id)invalid("Tracked mask lineage does not match the stored asset");
  const existing=asset.metadata?.maskReview;
  if(existing?.state==="approved"||existing?.state==="rejected"){
    const parsed=maskReviewReceiptSchema.safeParse(existing.receipt);
    if(!parsed.success||existing.version!==1)invalid("Stored mask review receipt is invalid");
    const stored=parsed.data,wanted=input.decision==="approve"?"approved":"rejected";
    if(stored.maskAssetId!==asset.id||stored.maskSha256!==asset.sha256||stored.sourceAssetId!==receipt.sourceAssetId||stored.sourceSha256!==receipt.sourceSha256||stored.projectId!==asset.project_id||stored.producerRunId!==receipt.producerRunId)invalid("Stored mask review receipt does not match its lineage");
    if(stored.decision!==wanted||existing.state!==wanted)throw new HttpError(409,"Tracked mask already has a conflicting review decision");
    return stored;
  }

  const source=(await client.query(
    "SELECT id,project_id,media_type,content_type,storage_key,sha256 FROM assets WHERE workspace_id=$1 AND id=$2",
    [input.workspaceId,receipt.sourceAssetId],
  )).rows[0];
  if(!source||source.id!==receipt.sourceAssetId||source.project_id!==asset.project_id||source.media_type!=="video"||!source.content_type?.startsWith("video/")||source.sha256!==receipt.sourceSha256)invalid("Tracked mask source lineage is no longer valid");

  const run=(await client.query(
    "SELECT id,project_id,route_id,state,workflow_revision_id,output_ids FROM runs WHERE workspace_id=$1 AND id=$2",
    [input.workspaceId,receipt.producerRunId],
  )).rows[0];
  const outputs=Array.isArray(run?.output_ids)?run.output_ids:[];
  if(!run||run.id!==receipt.producerRunId||run.project_id!==asset.project_id||run.route_id!==receipt.routeId||run.state!=="succeeded"||!outputs.includes(asset.id)||run.workflow_revision_id!==receipt.workflowRevisionId)invalid("Tracked mask producer lineage is no longer valid");

  const revision=(await client.query(
    "SELECT id,capability_id,version,sha256,manifest FROM workflow_revisions WHERE workspace_id=$1 AND id=$2",
    [input.workspaceId,receipt.workflowRevisionId],
  )).rows[0];
  if(!revision||revision.id!==receipt.workflowRevisionId||revision.capability_id!==receipt.workflowId||revision.version!==receipt.workflowVersion||revision.sha256!==receipt.workflowSha256||revision.manifest?.id!==receipt.workflowId||revision.manifest?.version!==receipt.workflowVersion)invalid("Tracked mask workflow lineage is no longer valid");
  const outputContract=revision.manifest?.outputContract;
  const route=revision.manifest?.routes?.find((candidate:any)=>candidate?.id===receipt.routeId);
  const requirement=route?.requirements?.find((candidate:any)=>candidate?.id===outputContract?.checkpointRequirementId);
  if(outputContract?.kind!=="source_linked_mask_v1"||outputContract.semantics!==receipt.semantics||requirement?.kind!=="model"||requirement.name!==receipt.requiredCheckpoint||requirement.version!==`sha256:${receipt.requiredCheckpointSha256}`)invalid("Tracked mask model lineage is no longer valid");
  const derived=maskSnapshotSchema.safeParse(maskSequence(receipt));
  if(!derived.success)invalid("Tracked mask media contract is invalid");

  let maskHash:string,sourceHash:string;
  try{
    [maskHash,sourceHash]=await Promise.all([
      fileSha256(await store.file(input.workspaceId,asset.storage_key)),
      fileSha256(await store.file(input.workspaceId,source.storage_key)),
    ]);
  }catch{invalid("Tracked mask review media is unavailable");}
  if(maskHash!==receipt.maskSha256||sourceHash!==receipt.sourceSha256)invalid("Tracked mask or source media changed after generation");

  if(existing?.version!==1||existing?.state!=="pending")invalid("Tracked mask is not pending review");

  const decision=input.decision==="approve"?"approved":"rejected";
  const review:MaskReviewDecisionReceipt={
    validationVersion:1,contract:"source_linked_mask_review_v1",decision,maskAssetId:asset.id,maskSha256:asset.sha256,
    sourceAssetId:source.id,sourceSha256:source.sha256,projectId:asset.project_id,producerRunId:run.id,
    reviewedBy:input.reviewedBy,reviewedAt:new Date().toISOString(),
  };
  maskReviewReceiptSchema.parse(review);
  const metadata={...asset.metadata,maskReview:{version:1,state:decision,receipt:review}};
  if(decision==="approved")metadata.maskSequence=derived.data;
  else delete metadata.maskSequence;
  await client.query("UPDATE assets SET metadata=$3 WHERE workspace_id=$1 AND id=$2",[input.workspaceId,asset.id,JSON.stringify(metadata)]);
  await client.query(
    "INSERT INTO run_events(workspace_id,run_id,state,detail) VALUES($1,$2,$3,$4)",
    [input.workspaceId,run.id,`mask_review_${decision}`,JSON.stringify({maskAssetId:asset.id,decision,reviewedBy:input.reviewedBy})],
  );
  return review;
}

export async function maskedMediaRoutes(app:FastifyInstance,pool:Pool,store:DiskStore){
  app.get("/api/v1/workspaces/:workspaceId/assets/:sourceId/tracking-runs",async request=>{
    const {workspaceId,sourceId}=z.object({workspaceId:z.uuid(),sourceId:z.uuid()}).parse(request.params),user=await member(pool,request,workspaceId);
    const {capabilityId}=z.object({capabilityId:z.string().min(1).max(120)}).strict().parse(request.query);
    const source=(await pool.query("SELECT id,project_id,sha256 FROM assets WHERE workspace_id=$1 AND id=$2 AND media_type='video'",[workspaceId,sourceId])).rows[0];if(!source)throw new HttpError(404,"Source video not found");
    const columns=publicColumns.split(",").map(c=>`r.${c}`).join(",");
    return (await pool.query(`SELECT ${columns},r.invocation FROM runs r JOIN run_inputs i ON i.workspace_id=r.workspace_id AND i.run_id=r.id JOIN workflow_revisions v ON v.workspace_id=r.workspace_id AND v.id=r.workflow_revision_id WHERE r.workspace_id=$1 AND i.asset_id=$2 AND i.role='source_video' AND r.project_id=$3 AND r.created_by=$4 AND r.capability_id=$5 AND r.state=ANY($6::text[]) AND v.manifest->'outputContract'->>'kind'='source_linked_mask_v1' AND r.invocation->'trackingSnapshot'->>'sourceSha256'=$7 ORDER BY r.created_at DESC LIMIT 20`,[workspaceId,sourceId,source.project_id,user.id,capabilityId,["pending","submitting","submission_unknown","queued","running","cancel_requested"],source.sha256])).rows.map(r=>({...r,remote_id:r.worker_id?r.remote_id:null}));
  });
  app.get("/api/v1/workspaces/:workspaceId/assets/:sourceId/tracked-masks",async request=>{
    const {workspaceId,sourceId}=z.object({workspaceId:z.uuid(),sourceId:z.uuid()}).parse(request.params);await member(pool,request,workspaceId);
    z.object({}).strict().parse(request.query);
    const source=(await pool.query("SELECT id,project_id,sha256 FROM assets WHERE workspace_id=$1 AND id=$2 AND media_type='video'",[workspaceId,sourceId])).rows[0];
    if(!source)throw new HttpError(404,"Source video not found");
    return (await pool.query(`SELECT id,project_id,name,media_type,content_type,sha256,bytes,parent_id,created_at,metadata FROM assets WHERE workspace_id=$1 AND project_id=$2 AND parent_id=$3 AND media_type='mask' AND content_type LIKE 'video/%' AND metadata->'sourceLinkedMask'->>'sourceAssetId'=$3::text AND metadata->'sourceLinkedMask'->>'sourceSha256'=$4 ORDER BY created_at DESC,id DESC LIMIT 20`,[workspaceId,source.project_id,sourceId,source.sha256])).rows;
  });
  app.get("/api/v1/workspaces/:workspaceId/masked-edit-requirements",async request=>{
    const {workspaceId}=z.object({workspaceId:z.uuid()}).parse(request.params);
    await member(pool,request,workspaceId);
    return maskedEditReadiness();
  });
  app.post("/api/v1/workspaces/:workspaceId/assets/:sourceId/mask-sequence",async request=>{
    const {workspaceId,sourceId}=z.object({workspaceId:z.uuid(),sourceId:z.uuid()}).parse(request.params);
    const user=await member(pool,request,workspaceId,"creator");
    z.object({}).strict().parse(request.query);
    const source=(await pool.query("SELECT * FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,sourceId])).rows[0];
    if(!source)throw new HttpError(404,"Source video not found");
    if(source.media_type!=="video"||!source.content_type.startsWith("video/"))throw new HttpError(422,"Choose a source video before uploading its mask");
    const file=await request.file();if(!file)throw new HttpError(400,"Choose an aligned grayscale mask video");
    if(!["video/mp4","video/webm","video/quicktime"].includes(file.mimetype)){file.file.resume();throw new HttpError(415,"Upload a video mask sequence");}
    const saved=await store.put(workspaceId,file.file),id=newId();let inserting=false;
    try{
      if(file.file.truncated)throw new HttpError(413,"Upload exceeds configured limit");
      const sourceFile=await store.file(workspaceId,source.storage_key),maskFile=await store.file(workspaceId,saved.key);
      let maskSequence;
      try{
        maskSequence=await validateMaskPair(sourceFile,maskFile,{sourceAssetId:sourceId,sourceSha256:source.sha256,maskSha256:saved.sha256});
      }catch(error){
        if(!(error instanceof HttpError)||error.statusCode!==422)throw error;
        // Ordinary camera footage is normalized into an aligned 16 FPS VACE derivative pair.
        // The uploaded original mask is not referenced after the normalized pair is stored.
        const normalized=await normalizeMaskPair(sourceFile,maskFile);
        const keys:string[]=[];let storedIds:{source:string;mask:string}|undefined;
        try{
          const normalizedSource=await store.put(workspaceId,createReadStream(normalized.sourcePath));keys.push(normalizedSource.key);
          const normalizedMask=await store.put(workspaceId,createReadStream(normalized.maskPath));keys.push(normalizedMask.key);
          const normalizedSourceId=newId(),maskAssetId=newId();
          const sequence={validationVersion:1 as const,sourceAssetId:sourceId,sourceSha256:source.sha256,maskSha256:normalizedMask.sha256,width:normalized.width,height:normalized.height,fps:16 as const,frames:normalized.frames,timingDigest:normalized.timingDigest,semantics:"white_edits_black_preserves" as const};
          const normalization={validationVersion:1 as const,contract:"mask_normalization_v1" as const,originalSourceAssetId:sourceId,originalSourceSha256:source.sha256,originalMaskSha256:saved.sha256,normalizedSourceAssetId:normalizedSourceId,normalizedSourceSha256:normalizedSource.sha256,normalizedMaskAssetId:maskAssetId,normalizedMaskSha256:normalizedMask.sha256,width:normalized.width,height:normalized.height,fps:16 as const,frames:normalized.frames,timingDigest:normalized.timingDigest,transform:normalized.transform};
          const row=await transaction(pool,async client=>{
            await client.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,'video','video/mp4',$5,$6,$7,$8,$9,$10)",[normalizedSourceId,workspaceId,source.project_id,`${String(source.name??"source").slice(0,200)} (masked edit 16 FPS)`,normalizedSource.key,normalizedSource.sha256,normalizedSource.bytes,user.id,sourceId,JSON.stringify({maskNormalizationSource:true})]);
            return (await client.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,'mask','video/mp4',$5,$6,$7,$8,$9,$10) RETURNING id,project_id,name,media_type,content_type,sha256,bytes,parent_id,created_at,metadata",[maskAssetId,workspaceId,source.project_id,`${file.filename.slice(0,200)} (normalized 16 FPS)`,normalizedMask.key,normalizedMask.sha256,normalizedMask.bytes,user.id,sourceId,JSON.stringify({maskSequence:sequence,maskNormalization:normalization})])).rows[0];
          });
          storedIds={source:normalizedSourceId,mask:maskAssetId};
          await store.remove(workspaceId,saved.key).catch(()=>{});
          return row;
        }catch(error){
          if(!storedIds)for(const key of keys)await store.remove(workspaceId,key).catch(()=>{});
          throw error;
        }finally{
          await normalized.cleanup();
        }
      }
      inserting=true;
      return (await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,'mask',$5,$6,$7,$8,$9,$10,$11) RETURNING id,project_id,name,media_type,content_type,sha256,bytes,parent_id,created_at,metadata",[id,workspaceId,source.project_id,file.filename.slice(0,240),file.mimetype,saved.key,saved.sha256,saved.bytes,user.id,sourceId,JSON.stringify({maskSequence})])).rows[0];
    }catch(error){
      // On an uncertain INSERT acknowledgement, retain the file unless absence is confirmed.
      const absent=!inserting||await pool.query("SELECT id FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,id]).then(r=>!r.rowCount).catch(()=>false);
      if(absent)await store.remove(workspaceId,saved.key).catch(()=>{});
      throw error;
    }
  });
  app.post("/api/v1/workspaces/:workspaceId/assets/:id/mask-review",async request=>{
    const {workspaceId,id}=z.object({workspaceId:z.uuid(),id:z.uuid()}).parse(request.params);
    const user=await member(pool,request,workspaceId,"creator");
    z.object({}).strict().parse(request.query);
    const body=reviewBody.parse(request.body);
    return transaction(pool,client=>reviewSourceLinkedMask(client,store,{workspaceId,maskAssetId:id,...body,reviewedBy:user.id}));
  });
}

import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import {HttpError} from "./auth";
import {sanitizedPosePreview} from "./pose-preview-admission";
import {transaction} from "./db";
import {validatePngBytes,type PngValidationLimits} from "./image-artifacts-validation";
import type {ImageArtifactsContractV1} from "../src/capabilities/image-artifacts";

const roleSchema=z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const digestSchema=z.string().regex(/^[a-f0-9]{64}$/);
const mediaTypeSchema=z.enum(["image","mask","layer"]);
const safeText=z.string().trim().min(1).max(240);
const imageValidationSchema=z.object({
  validationVersion:z.literal(1),format:z.literal("png"),width:z.number().int().positive(),height:z.number().int().positive(),
  hasAlpha:z.boolean(),semantic:mediaTypeSchema,
}).strict();
const relationMetadataSchema=z.object({assetSha256:digestSchema.optional()}).strip();

export type ImageArtifactMediaType=z.infer<typeof mediaTypeSchema>;
export type ArtifactSlotSpec={role:string;ordinal:number;mediaType:ImageArtifactMediaType};
export type PlannedArtifactSlot=ArtifactSlotSpec&{slotId:string;assetId:string};
export type ArtifactRelation={assetId:string;role:string;ordinal:number;metadata?:Record<string,unknown>};
export type StagedImageArtifact=PlannedArtifactSlot&{
  name:string;contentType:"image/png";storageKey:string;sha256:string;bytes:number;
  metadata:Record<string,unknown>;relations:ArtifactRelation[];
};
export type ArtifactPublicationInput={
  workspaceId:string;projectId:string;runId:string;createdBy:string;artifacts:StagedImageArtifact[];
};
export type ArtifactPublicationResult={status:"published"|"already_published"|"canceled";outputIds:string[]};
export type PngArtifactPolicy=PngValidationLimits&{alpha:"allow"|"require"|"forbid"};
export type ImageArtifactFile={filename:string;subfolder:string;type:"output"};
export type ResolvedImageArtifact={declarationId:string;outputPort:string;node:string;role:ImageArtifactMediaType;ordinal:number;file:ImageArtifactFile};

function safeImageFile(value:unknown):ImageArtifactFile{
  if(!value||typeof value!=="object"||Array.isArray(value))throw new HttpError(422,"Worker returned an invalid image artifact entry");
  const file=value as Record<string,unknown>;
  if(typeof file.filename!=="string"||!file.filename||file.filename.length>240||/[\\/]|\.\./.test(file.filename)
    ||typeof file.subfolder!=="string"||/(^|[\\/])\.\.([\\/]|$)|^[\\/]|:/.test(file.subfolder)
    ||file.type!=="output")throw new HttpError(422,"Worker returned an unsafe image artifact path");
  return {filename:file.filename,subfolder:file.subfolder,type:"output"};
}

/**
 * Resolve only the SaveImage arrays named by the pinned manifest. Unrelated
 * history nodes and keys are intentionally ignored; declaration and array
 * order become the durable artifact order.
 */
export function resolveDeclaredImageArtifacts(contract:ImageArtifactsContractV1,outputs:Record<string,Record<string,unknown>>):ResolvedImageArtifact[]{
  if(contract.kind!=="image_artifacts_v1"||contract.schemaVersion!==1)throw new HttpError(422,"Pinned image artifact contract is invalid");
  const resolved:ResolvedImageArtifact[]=[];
  const roleOrdinals=new Map<string,number>(),seenFiles=new Set<string>();
  for(const declaration of contract.artifacts){
    const images=outputs[declaration.node]?.images;
    if(!Array.isArray(images)||images.length<declaration.cardinality.min||images.length>declaration.cardinality.max)throw new HttpError(422,"Worker image artifact cardinality does not match the pinned contract");
    for(const candidate of images.slice(declaration.indexing.start)){
      const file=safeImageFile(candidate),key=`${file.subfolder}/${file.filename}`;
      if(seenFiles.has(key))throw new HttpError(422,"Worker returned the same image artifact more than once");seenFiles.add(key);
      const ordinal=roleOrdinals.get(declaration.role)??0;roleOrdinals.set(declaration.role,ordinal+1);
      resolved.push({declarationId:declaration.id,outputPort:declaration.outputPort,node:declaration.node,role:declaration.role,ordinal,file});
    }
  }
  if(!resolved.length||resolved.length>contract.maxArtifacts)throw new HttpError(422,"Worker image artifact batch exceeds the pinned contract");
  return resolved;
}

/** Admission can plan deterministic slots only when every declaration has an exact count. */
export function exactImageArtifactSlotSpecs(contract:ImageArtifactsContractV1):ArtifactSlotSpec[]{
  const specs:ArtifactSlotSpec[]=[],roleOrdinals=new Map<string,number>();
  for(const declaration of contract.artifacts){
    if(declaration.cardinality.min!==declaration.cardinality.max)throw new HttpError(422,"Variable image artifact cardinality is not supported for durable execution");
    for(let index=0;index<declaration.cardinality.max;index+=1){
      const ordinal=roleOrdinals.get(declaration.role)??0;roleOrdinals.set(declaration.role,ordinal+1);
      specs.push({role:declaration.role,ordinal,mediaType:declaration.role});
    }
  }
  if(!specs.length||specs.length>contract.maxArtifacts)throw new HttpError(422,"Image artifact plan exceeds the pinned contract");
  return specs;
}

function deterministicUuid(domain:string,runId:string,role:string,ordinal:number):string{
  const parsedRun=z.uuid().parse(runId).toLowerCase(),parsedRole=roleSchema.parse(role);
  z.number().int().nonnegative().parse(ordinal);
  const bytes=createHash("sha256").update(`${domain}\0${parsedRun}\0${parsedRole}\0${ordinal}`).digest().subarray(0,16);
  // RFC 9562 UUIDv8: application-defined bits with the standard variant.
  bytes[6]=(bytes[6]&0x0f)|0x80;bytes[8]=(bytes[8]&0x3f)|0x80;
  const hex=bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function stableArtifactSlotId(runId:string,role:string,ordinal:number):string{
  return deterministicUuid("comfyfield/run-artifact-slot/v1",runId,role,ordinal);
}
export function stableArtifactId(runId:string,role:string,ordinal:number):string{
  return deterministicUuid("comfyfield/run-artifact-asset/v1",runId,role,ordinal);
}

/** Pure deterministic planning; callers can persist it before remote execution. */
export function planArtifactSlots(runId:string,specs:ArtifactSlotSpec[]):PlannedArtifactSlot[]{
  if(!specs.length||specs.length>64)throw new HttpError(422,"Plan one to 64 image artifacts");
  const seen=new Set<string>();
  return specs.map(spec=>{
    const role=roleSchema.parse(spec.role),ordinal=z.number().int().nonnegative().parse(spec.ordinal),mediaType=mediaTypeSchema.parse(spec.mediaType);
    const key=`${role}/${ordinal}`;if(seen.has(key))throw new HttpError(422,"Artifact slot roles and ordinals must be unique");seen.add(key);
    return {role,ordinal,mediaType,slotId:stableArtifactSlotId(runId,role,ordinal),assetId:stableArtifactId(runId,role,ordinal)};
  });
}

/** Validate every candidate before any staging/publication query is allowed. */
export function validateStagedArtifactBatch(runId:string,artifacts:StagedImageArtifact[]):StagedImageArtifact[]{
  const planned=planArtifactSlots(runId,artifacts.map(({role,ordinal,mediaType})=>({role,ordinal,mediaType})));
  const assetIds=new Set<string>();
  return artifacts.map((artifact,index)=>{
    const expected=planned[index];
    if(artifact.slotId!==expected.slotId||artifact.assetId!==expected.assetId)throw new HttpError(422,"Artifact slot identity does not match its run plan");
    z.object({name:safeText,contentType:z.literal("image/png"),storageKey:z.string().min(1).max(1024),sha256:digestSchema,bytes:z.number().int().positive(),metadata:z.record(z.string(),z.unknown()),relations:z.array(z.object({assetId:z.uuid(),role:roleSchema,ordinal:z.number().int().nonnegative(),metadata:z.record(z.string(),z.unknown()).optional()}).strict()).max(64)}).strict().parse({name:artifact.name,contentType:artifact.contentType,storageKey:artifact.storageKey,sha256:artifact.sha256,bytes:artifact.bytes,metadata:artifact.metadata,relations:artifact.relations});
    if(assetIds.has(artifact.assetId))throw new HttpError(422,"Artifact IDs must be unique");assetIds.add(artifact.assetId);
    const validation=imageValidationSchema.safeParse(artifact.metadata.imageValidation);
    if(!validation.success||validation.data.semantic!==artifact.mediaType)throw new HttpError(422,"Artifact is missing its matching PNG validation receipt");
    const relations=new Set<string>();
    for(const relation of artifact.relations){
      if(relation.assetId===artifact.assetId)throw new HttpError(422,"An artifact cannot relate to itself");
      const key=`${relation.role}/${relation.ordinal}`;if(relations.has(key))throw new HttpError(422,"Artifact relation roles and ordinals must be unique");relations.add(key);
    }
    return {...artifact,relations:artifact.relations.map(relation=>({
      ...relation,
      ...(relation.metadata===undefined?{}:{metadata:sanitizedRelationMetadata(relation.metadata)}),
    }))};
  });
}

/**
 * Decode and verify every staged PNG before the caller records any staging or
 * publication state. The hash/length checks bind the receipt to the exact bytes
 * already placed in storage; alpha policy comes from the pinned workflow.
 */
export async function validatePngArtifactBatch(
  artifacts:StagedImageArtifact[],
  policies:Map<string,PngArtifactPolicy>,
  readBytes:(storageKey:string)=>Promise<Uint8Array>,
):Promise<StagedImageArtifact[]>{
  const validated:StagedImageArtifact[]=[];
  for(const artifact of artifacts){
    const policy=policies.get(artifact.slotId);if(!policy)throw new HttpError(422,"Artifact validation policy is unavailable");
    const bytes=await readBytes(artifact.storageKey);
    if(bytes.byteLength!==artifact.bytes||createHash("sha256").update(bytes).digest("hex")!==artifact.sha256)throw new HttpError(422,"Staged artifact bytes changed before validation");
    const result=await validatePngBytes(bytes,policy);
    if(policy.alpha==="require"&&!result.hasAlpha)throw new HttpError(422,"This artifact requires meaningful PNG transparency");
    if(policy.alpha==="forbid"&&result.hasAlpha)throw new HttpError(422,"This artifact must be an opaque PNG");
    validated.push({...artifact,metadata:{...artifact.metadata,imageValidation:{validationVersion:1,format:"png",width:result.width,height:result.height,hasAlpha:result.hasAlpha,semantic:artifact.mediaType}}});
  }
  return validated;
}

/** Persist the deterministic plan without changing an already-staged/published slot. */
export async function persistArtifactPlan(pool:Pool,input:{workspaceId:string;projectId:string;runId:string;specs:ArtifactSlotSpec[]}):Promise<PlannedArtifactSlot[]>{
  return transaction(pool,client=>persistArtifactPlanWithClient(client,input));
}

/** Transaction-scoped variant used while the run row is first admitted. */
export async function persistArtifactPlanWithClient(client:PoolClient,input:{workspaceId:string;projectId:string;runId:string;specs:ArtifactSlotSpec[]}):Promise<PlannedArtifactSlot[]>{
    const ids=[input.workspaceId,input.projectId,input.runId].map(value=>z.uuid().parse(value));
    const slots=planArtifactSlots(input.runId,input.specs);
    const run=(await client.query("SELECT id FROM runs WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",ids)).rows[0];
    if(!run)throw new HttpError(404,"Run not found in this project");
    for(const slot of slots)await client.query(
      `INSERT INTO run_artifact_slots(workspace_id,project_id,run_id,slot_id,asset_id,role,ordinal,media_type)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(workspace_id,run_id,role,ordinal) DO NOTHING`,
      [...ids,slot.slotId,slot.assetId,slot.role,slot.ordinal,slot.mediaType],
    );
    const rows=(await client.query("SELECT slot_id,asset_id,role,ordinal,media_type FROM run_artifact_slots WHERE workspace_id=$1 AND run_id=$2 ORDER BY role,ordinal",[input.workspaceId,input.runId])).rows;
    if(rows.length!==slots.length)throw new HttpError(409,"Run artifact plan conflicts with its durable slots");
    const existing=new Map(rows.map(row=>[`${row.role}/${row.ordinal}`,row]));
    for(const slot of slots){const row=existing.get(`${slot.role}/${slot.ordinal}`);if(!row||row.slot_id!==slot.slotId||row.asset_id!==slot.assetId||row.media_type!==slot.mediaType)throw new HttpError(409,"Run artifact plan conflicts with its durable slots");}
    return slots;
}

/** Staging is separate from publication so a restart can find validated bytes. */
export async function recordStagedArtifactBatch(pool:Pool,input:ArtifactPublicationInput):Promise<void>{
  const artifacts=validateStagedArtifactBatch(input.runId,input.artifacts);
  await transaction(pool,async client=>{
    const run=(await client.query("SELECT state FROM runs WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",[input.workspaceId,input.projectId,input.runId])).rows[0];
    if(!run)throw new HttpError(404,"Run not found in this project");
    if(["succeeded","failed","canceled"].includes(run.state))throw new HttpError(409,"Run no longer accepts staged artifacts");
    for(const artifact of artifacts){
      const result=await client.query(
        `UPDATE run_artifact_slots SET state='staged',staged_storage_key=$1,staged_content_type=$2,staged_sha256=$3,
         staged_bytes=$4,staged_name=$5,staged_metadata=$6,staged_relations=$7,updated_at=now()
         WHERE workspace_id=$8 AND project_id=$9 AND run_id=$10 AND slot_id=$11 AND asset_id=$12
           AND role=$13 AND ordinal=$14 AND media_type=$15
           AND (state='planned' OR (state='staged' AND staged_storage_key=$1 AND staged_content_type=$2
             AND staged_sha256=$3 AND staged_bytes=$4 AND staged_name=$5 AND staged_metadata=$6::jsonb AND staged_relations=$7::jsonb))
         RETURNING staged_storage_key,staged_sha256,staged_bytes`,
        [artifact.storageKey,artifact.contentType,artifact.sha256,artifact.bytes,artifact.name,JSON.stringify(artifact.metadata),JSON.stringify(artifact.relations),input.workspaceId,input.projectId,input.runId,artifact.slotId,artifact.assetId,artifact.role,artifact.ordinal,artifact.mediaType],
      );
      const row=result.rows[0];
      if(!row||row.staged_storage_key!==artifact.storageKey||row.staged_sha256!==artifact.sha256||Number(row.staged_bytes)!==artifact.bytes)throw new HttpError(409,"Artifact staging conflicts with its durable slot");
    }
  });
}

async function publicationGate(client:PoolClient,input:ArtifactPublicationInput,outputIds:string[]):Promise<"publish"|"already_published"|"canceled">{
  const run=(await client.query("SELECT state,output_ids,created_by FROM runs WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE",[input.workspaceId,input.projectId,input.runId])).rows[0];
  if(!run)throw new HttpError(404,"Run not found in this project");
  if(run.created_by!==input.createdBy)throw new HttpError(403,"Artifact publisher does not match the run creator");
  if(run.state==="succeeded"){
    if(JSON.stringify(run.output_ids)!==JSON.stringify(outputIds))throw new HttpError(409,"Run already published a different artifact batch");
    return "already_published";
  }
  if(run.state==="canceled")return "canceled";
  if(run.state==="cancel_requested"){
    await client.query("UPDATE runs SET state='canceled',error=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",[input.workspaceId,input.runId]);
    await client.query("UPDATE run_artifact_slots SET state='discarded',updated_at=now() WHERE workspace_id=$1 AND run_id=$2 AND state<>'published'",[input.workspaceId,input.runId]);
    await client.query("INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,'canceled')",[input.workspaceId,input.runId]);
    return "canceled";
  }
  if(!["submission_unknown","queued","running"].includes(run.state))throw new HttpError(409,"Run is not eligible to publish artifacts");
  return "publish";
}

async function durablePublication(pool:Pool,input:ArtifactPublicationInput,outputIds:string[]):Promise<boolean>{
  try{
    const run=(await pool.query("SELECT state,output_ids,created_by FROM runs WHERE workspace_id=$1 AND project_id=$2 AND id=$3",[input.workspaceId,input.projectId,input.runId])).rows[0];
    if(run?.created_by!==input.createdBy||run.state!=="succeeded"||JSON.stringify(run.output_ids)!==JSON.stringify(outputIds))return false;
    const rows=(await pool.query("SELECT asset_id,published_asset_id,state FROM run_artifact_slots WHERE workspace_id=$1 AND run_id=$2 AND asset_id=ANY($3::uuid[])",[input.workspaceId,input.runId,outputIds])).rows;
    return rows.length===outputIds.length&&rows.every(row=>row.state==="published"&&row.asset_id===row.published_asset_id);
  }catch{return false;}
}

/**
 * Publish assets, their ordered relations, slot transitions and run outputs in
 * one transaction. A lost COMMIT acknowledgement is resolved by a durable
 * re-read using deterministic asset IDs; callers must retain bytes on errors.
 */
export async function publishStagedArtifactBatch(pool:Pool,input:ArtifactPublicationInput):Promise<ArtifactPublicationResult>{
  const artifacts=validateStagedArtifactBatch(input.runId,input.artifacts);
  const outputIds=artifacts.map(artifact=>artifact.assetId);
  try{
    const result=await transaction(pool,async client=>{
      const gate=await publicationGate(client,input,outputIds);
      if(gate!=="publish")return {status:gate,outputIds:gate==="already_published"?outputIds:[]} as ArtifactPublicationResult;
      const slots=(await client.query("SELECT * FROM run_artifact_slots WHERE workspace_id=$1 AND project_id=$2 AND run_id=$3 FOR UPDATE",[input.workspaceId,input.projectId,input.runId])).rows;
      if(slots.length!==artifacts.length)throw new HttpError(409,"Artifact batch does not match the durable run plan");
      for(const artifact of artifacts){
        const slot=slots.find(row=>row.slot_id===artifact.slotId&&row.asset_id===artifact.assetId);
        if(!slot||slot.state!=="staged"||slot.media_type!==artifact.mediaType||slot.staged_storage_key!==artifact.storageKey||slot.staged_content_type!==artifact.contentType||slot.staged_sha256!==artifact.sha256||Number(slot.staged_bytes)!==artifact.bytes||slot.staged_name!==artifact.name||!isDeepStrictEqual(slot.staged_metadata,artifact.metadata)||!isDeepStrictEqual(slot.staged_relations,artifact.relations))throw new HttpError(409,"Artifact does not match its staged slot");
        if(!artifact.storageKey.startsWith(`${input.workspaceId}/`))throw new HttpError(422,"Artifact storage does not belong to this workspace");
        await client.query(
          "INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [artifact.assetId,input.workspaceId,input.projectId,artifact.name,artifact.mediaType,artifact.contentType,artifact.storageKey,artifact.sha256,artifact.bytes,input.createdBy,JSON.stringify(sanitizedImageProvenance(artifact.metadata))],
        );
      }
      const relatedIds=[...new Set(artifacts.flatMap(artifact=>artifact.relations.map(relation=>relation.assetId)))];
      if(relatedIds.length){
        const found=(await client.query("SELECT id FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])",[input.workspaceId,input.projectId,relatedIds])).rows;
        if(found.length!==relatedIds.length)throw new HttpError(422,"Artifact relations must reference assets in the same project");
      }
      for(const artifact of artifacts)for(const relation of artifact.relations)await client.query(
        "INSERT INTO asset_relations(workspace_id,project_id,asset_id,related_asset_id,role,ordinal,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [input.workspaceId,input.projectId,artifact.assetId,relation.assetId,relation.role,relation.ordinal,JSON.stringify(sanitizedRelationMetadata(relation.metadata))],
      );
      for(const artifact of artifacts)await client.query("UPDATE run_artifact_slots SET state='published',published_asset_id=asset_id,updated_at=now() WHERE workspace_id=$1 AND slot_id=$2",[input.workspaceId,artifact.slotId]);
      await client.query("UPDATE runs SET state='succeeded',output_ids=$1,error=NULL,updated_at=now() WHERE workspace_id=$2 AND id=$3",[JSON.stringify(outputIds),input.workspaceId,input.runId]);
      await client.query("INSERT INTO run_events(workspace_id,run_id,state,detail) VALUES($1,$2,'succeeded',$3)",[input.workspaceId,input.runId,JSON.stringify({artifactSlots:artifacts.map(({slotId,assetId,role,ordinal})=>({slotId,assetId,role,ordinal}))})]);
      return {status:"published" as const,outputIds};
    });
    if(result.status==="already_published"&&!await durablePublication(pool,input,outputIds))throw new HttpError(409,"Run publication state is incomplete");
    return result;
  }catch(error){
    if(error instanceof HttpError&&error.statusCode===403)throw error;
    if(await durablePublication(pool,input,outputIds))return {status:"already_published",outputIds};
    throw error;
  }
}

/**
 * Resolve every storage key that durable state may still reference. Published
 * slots deliberately retain their staged key; the asset join is an additional
 * guard for commit-acknowledgement uncertainty and later schema evolution.
 */
export async function durableArtifactStorageKeys(pool:Pool,input:{workspaceId:string;runId:string;assetIds:string[]}):Promise<Set<string>>{
  z.uuid().parse(input.workspaceId);z.uuid().parse(input.runId);input.assetIds.forEach(id=>z.uuid().parse(id));
  const rows=(await pool.query(`SELECT s.staged_storage_key,a.storage_key AS asset_storage_key
    FROM run_artifact_slots s LEFT JOIN assets a ON a.workspace_id=s.workspace_id AND a.id=s.asset_id
    WHERE s.workspace_id=$1 AND s.run_id=$2 AND s.asset_id=ANY($3::uuid[])
      AND (s.state IN ('staged','published') OR a.id IS NOT NULL)`,[input.workspaceId,input.runId,input.assetIds])).rows;
  return new Set(rows.flatMap(row=>[row.staged_storage_key,row.asset_storage_key]).filter((key):key is string=>typeof key==="string"&&key.length>0));
}

const safeGeneratedBy=z.object({
  producerRunId:z.uuid().optional(),workflowRevisionId:z.uuid().optional(),capabilityId:z.string().max(120).optional(),
  capabilityVersion:z.string().max(80).optional(),routeId:z.string().max(120).optional(),operation:z.string().max(120).optional(),
}).strip();
const safeValidation=imageValidationSchema.strip();
const safePreservation=z.object({
  kind:z.literal("klein_still_v1"),sourceAssetId:z.uuid(),candidateAssetId:z.uuid(),finalAssetId:z.uuid(),effectiveMaskAssetId:z.uuid(),
  report:z.string().min(1).max(65536),upstream:z.object({klein:z.string().regex(/^[a-f0-9]{40}$/),cropStitch:z.string().regex(/^[a-f0-9]{40}$/)}).strict(),
  qa:z.object({method:z.literal("srgb8-max-channel-v1"),channelTolerance:z.literal(2),excludedMask:z.literal("effective mask > 0/255"),driftTolerancePercent:z.literal(.1),
    protectedPixels:z.number().int().min(0).max(4194304),changedProtectedPixels:z.number().int().min(0).max(4194304),
    driftPercent:z.number().min(0).max(100).nullable(),maxChannelDelta:z.number().min(0).max(255),meanChannelDelta:z.number().min(0).max(255).nullable(),withinTolerance:z.boolean(),
    width:z.number().int().positive().max(2048),height:z.number().int().positive().max(2048),}).strict(),
}).strict();

/** Typed public provenance. Opaque storage/provider fields are excluded. */
export function sanitizedImageProvenance(metadata:unknown):Record<string,unknown>{
  if(!metadata||typeof metadata!=="object"||Array.isArray(metadata))return {};
  const value=metadata as Record<string,unknown>,result:Record<string,unknown>={};
  const validation=safeValidation.safeParse(value.imageValidation);if(validation.success)result.imageValidation=validation.data;
  const generatedBy=safeGeneratedBy.safeParse(value.generatedBy);if(generatedBy.success&&Object.keys(generatedBy.data).length)result.generatedBy=generatedBy.data;
  const preservation=safePreservation.safeParse(value.preservation);if(preservation.success)result.preservation=preservation.data;
  const pose=sanitizedPosePreview(value.posePreview);if(pose)result.posePreview=pose;
  return result;
}

/** Allow-list relation provenance separately from asset metadata. */
export function sanitizedRelationMetadata(metadata:unknown):Record<string,unknown>{
  if(!metadata||typeof metadata!=="object"||Array.isArray(metadata))return {};
  const parsed=relationMetadataSchema.safeParse(metadata);
  return parsed.success?parsed.data:{};
}

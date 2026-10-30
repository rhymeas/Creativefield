import type {PoolClient} from "pg";
import type {MaskReviewDecisionReceipt} from "../src/capabilities/types";
import {HttpError} from "./auth";
import type {DiskStore} from "./storage";
import type {ResolvedRunAsset} from "./element-inputs";
import {maskNormalizationSchema,maskReviewReceiptSchema,maskSnapshotSchema,sourceLinkedMaskSchema,validateMaskPair} from "./masked-media";

type MediaAsset={id:string;project_id:string|null;parent_id?:string|null;sha256:string;storage_key?:string;content_type?:string;media_type?:string;metadata?:Record<string,unknown>};
export function approvedGeneratedMaskReview(mask:MediaAsset,source:MediaAsset):MaskReviewDecisionReceipt|undefined{
  const metadata=mask.metadata??{};if(metadata.sourceLinkedMask===undefined&&metadata.maskReview===undefined)return undefined;
  const linked=sourceLinkedMaskSchema.safeParse(metadata.sourceLinkedMask),container=metadata.maskReview as {state?:unknown;receipt?:unknown}|undefined,reviewed=maskReviewReceiptSchema.safeParse(container?.receipt);
  if(!linked.success||container?.state!=="approved"||!reviewed.success||reviewed.data.decision!=="approved")throw new HttpError(422,"Review and approve this generated mask before masked editing");
  const l=linked.data,r=reviewed.data;
  if(mask.project_id!==source.project_id||mask.parent_id!==source.id||l.maskAssetId!==mask.id||l.maskSha256!==mask.sha256||l.sourceAssetId!==source.id||l.sourceSha256!==source.sha256||l.projectId!==source.project_id||r.maskAssetId!==mask.id||r.maskSha256!==mask.sha256||r.sourceAssetId!==source.id||r.sourceSha256!==source.sha256||r.projectId!==source.project_id||r.producerRunId!==l.producerRunId)throw new HttpError(422,"Generated mask approval no longer matches this source and mask");
  return r;
}
/** Same complete admission for every region, including original normalization and producer provenance. */
export async function admitAlignedMask(client:PoolClient,store:DiskStore,workspaceId:string,projectId:string,source:ResolvedRunAsset,mask:ResolvedRunAsset){
  if(!source||!mask||source.project_id!==projectId||mask.project_id!==projectId||!source.storage_key||!mask.storage_key)throw new HttpError(422,"Upload a validated mask sequence for this exact source video");
  const review=approvedGeneratedMaskReview(mask,source),parsed=maskSnapshotSchema.safeParse(mask.metadata?.maskSequence);
  if(!parsed.success||parsed.data.sourceAssetId!==source.id||parsed.data.sourceSha256!==source.sha256||parsed.data.maskSha256!==mask.sha256)throw new HttpError(422,"Upload a validated mask sequence for this exact source video");
  const normalization=maskNormalizationSchema.safeParse(mask.metadata?.maskNormalization);let executionSource=source;
  if(normalization.success){
    if(review)throw new HttpError(422,"A generated tracked mask cannot carry an envelope normalization receipt");const n=normalization.data;
    if(n.originalSourceAssetId!==source.id||n.originalSourceSha256!==source.sha256||n.normalizedMaskAssetId!==mask.id||n.normalizedMaskSha256!==mask.sha256||n.width!==parsed.data.width||n.height!==parsed.data.height||n.frames!==parsed.data.frames||n.timingDigest!==parsed.data.timingDigest)throw new HttpError(422,"Normalized mask envelope no longer matches its validation receipt");
    const normalized=(await client.query("SELECT * FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=$3",[workspaceId,projectId,n.normalizedSourceAssetId])).rows[0];
    if(!normalized||normalized.media_type!=="video"||!normalized.content_type?.startsWith("video/")||!normalized.storage_key||normalized.sha256!==n.normalizedSourceSha256||normalized.parent_id!==source.id)throw new HttpError(422,"The normalized masked-edit source is missing or changed; upload the mask again");executionSource=normalized;
  }
  if(review){
    const linked=sourceLinkedMaskSchema.parse(mask.metadata?.sourceLinkedMask);
    if(parsed.data.width!==linked.width||parsed.data.height!==linked.height||parsed.data.fps!==linked.fps||parsed.data.frames!==linked.frames||parsed.data.timingDigest!==linked.timingDigest)throw new HttpError(422,"Generated mask validation no longer matches its tracking output");
    const producer=(await client.query("SELECT workflow_revision_id,route_id,state,output_ids FROM runs WHERE workspace_id=$1 AND id=$2 AND project_id=$3",[workspaceId,linked.producerRunId,projectId])).rows[0];
    if(!producer||producer.state!=="succeeded"||producer.route_id!==linked.routeId||producer.workflow_revision_id!==linked.workflowRevisionId||!Array.isArray(producer.output_ids)||!producer.output_ids.includes(mask.id))throw new HttpError(422,"Generated mask producer provenance is invalid");
    const revision=(await client.query("SELECT capability_id,version,sha256,manifest FROM workflow_revisions WHERE workspace_id=$1 AND id=$2",[workspaceId,linked.workflowRevisionId])).rows[0],route=revision?.manifest?.routes?.find((r:any)=>r.id===linked.routeId),requirement=route?.requirements?.find((r:any)=>r.id===revision?.manifest?.outputContract?.checkpointRequirementId);
    if(!revision||revision.capability_id!==linked.workflowId||revision.version!==linked.workflowVersion||revision.sha256!==linked.workflowSha256||requirement?.name!==linked.requiredCheckpoint||requirement?.version!==`sha256:${linked.requiredCheckpointSha256}`)throw new HttpError(422,"Generated mask workflow provenance is invalid");
  }
  let sourceFile:string,maskFile:string;try{sourceFile=await store.file(workspaceId,executionSource.storage_key!);maskFile=await store.file(workspaceId,mask.storage_key);}catch{throw new HttpError(422,"Validated source or mask is missing from storage; upload it again");}
  const media=await validateMaskPair(sourceFile,maskFile,{sourceAssetId:executionSource.id,sourceSha256:executionSource.sha256,maskSha256:mask.sha256});
  for(const key of ["width","height","frames","fps","timingDigest"] as const)if(media[key]!==parsed.data[key])throw new HttpError(422,"Mask media no longer matches its validation receipt");
  return {source:executionSource,media,...(review?{review}:{}),...(normalization.success?{normalization:normalization.data}:{})};
}

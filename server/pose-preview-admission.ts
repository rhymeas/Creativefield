import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import type {CapabilityManifestV2,Invocation} from "../src/capabilities/types";
import {readPoseFrames,poseFramePlan,type PosePreviewSnapshot} from "../src/capabilities/pose-preview";
import {HttpError} from "./auth";
import {fileSha256} from "./masked-media";
import type {DiskStore} from "./storage";
import {motionReceiptSchema} from "./motion-media";
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const posePreviewSnapshotSchema=z.object({validationVersion:z.literal(1),previewId:z.uuid(),sourceAssetId:z.uuid(),sourceSha256:digest,normalizedSha256:digest,width:z.number().int().min(1).max(1920),height:z.number().int().min(1).max(1920),fps:z.literal(24),frames:z.array(z.object({inputPort:z.string().regex(/^frame_[0-5]$/),assetId:z.uuid(),sha256:digest,frameIndex:z.number().int().min(0).max(640),seconds:z.number().finite().min(0).max(27)}).strict()).min(1).max(6)}).strict().refine(value=>value.width*value.height<=2073600&&value.frames.every((f,i)=>f.inputPort===`frame_${i}`&&f.seconds===f.frameIndex/24&&(i===0||f.frameIndex>value.frames[i-1].frameIndex)));
const poseOutputSchema=z.object({version:z.literal(1),previewId:z.uuid(),sourceAssetId:z.uuid(),sourceSha256:digest,normalizedSha256:digest,frameAssetId:z.uuid(),frameSha256:digest,frameIndex:z.number().int().min(0).max(640),seconds:z.number().finite().min(0).max(27),fps:z.literal(24),pose:z.unknown()}).strict().refine(value=>value.seconds===value.frameIndex/24);
export function sanitizedPosePreview(value:unknown){
  const parsed=poseOutputSchema.safeParse(value);if(!parsed.success)return undefined;const p=parsed.data.pose as {canvas_width?:number;canvas_height?:number}|undefined;
  if(!p||!p.canvas_width||!p.canvas_height||p.canvas_width>1920||p.canvas_height>1920||p.canvas_width*p.canvas_height>2073600)return undefined;
  const pose=readPoseFrames([p],{count:1,width:p.canvas_width,height:p.canvas_height});return pose?{...parsed.data,pose:pose[0]}:undefined;
}
type InputAsset={id:string;project_id:string|null;media_type:string;sha256:string;storage_key:string};

/** Only frame assets published by the server-owned preview ledger can be admitted. */
export async function admitPosePreview(client:PoolClient,manifest:CapabilityManifestV2,assets:Record<string,InputAsset>,workspaceId:string,projectId:string,store:DiskStore):Promise<PosePreviewSnapshot>{
  const contract=manifest.posePreviewContract;if(!contract)throw Error("Pose contract required");
  const ids=contract.frameInputs.map(role=>assets[role]?.id??"");if(ids.some(id=>!id)||new Set(ids).size!==ids.length)throw new HttpError(422,"Use distinct prepared driving frames for this pose preview.");
  const rows=(await client.query("SELECT p.id AS preview_id,p.project_id,p.source_asset_id,p.source_sha256,p.normalized_receipt,p.normalized_receipt->>'normalizedSha256' AS normalized_sha256,p.state,f.* FROM pose_previews p JOIN pose_preview_frames f ON f.workspace_id=p.workspace_id AND f.preview_id=p.id WHERE p.workspace_id=$1 AND f.asset_id=ANY($2::uuid[]) ORDER BY f.ordinal",[workspaceId,ids])).rows;
  if(rows.length!==ids.length||rows.some((r,i)=>r.state!=="prepared"||r.project_id!==projectId||r.preview_id!==rows[0].preview_id||r.ordinal!==i||r.asset_id!==ids[i]||r.sha256!==assets[contract.frameInputs[i]].sha256||assets[contract.frameInputs[i]].project_id!==projectId||assets[contract.frameInputs[i]].media_type!=="image"||r.width!==rows[0].width||r.height!==rows[0].height))throw new HttpError(422,"These frames are not a prepared preview of this driving clip.");
  const first=rows[0],normalized=motionReceiptSchema.safeParse(first.normalized_receipt);
  if(!normalized.success||normalized.data.workspaceId!==workspaceId||normalized.data.sourceSha256!==first.source_sha256||normalized.data.normalizedSha256!==first.normalized_sha256||normalized.data.width!==first.width||normalized.data.height!==first.height)throw new HttpError(422,"The driving normalization receipt is invalid.");
  const plan=poseFramePlan(normalized.data.decodedFrameCount);if(plan.length!==rows.length||rows.some((r,i)=>r.frame_index!==plan[i].frameIndex||r.seconds!==plan[i].seconds))throw new HttpError(422,"The prepared pose sampling clock changed.");
  const snapshot=posePreviewSnapshotSchema.parse({validationVersion:1,previewId:first.preview_id,sourceAssetId:first.source_asset_id,sourceSha256:first.source_sha256,normalizedSha256:first.normalized_sha256,width:first.width,height:first.height,fps:24,frames:rows.map((r,i)=>({inputPort:contract.frameInputs[i],assetId:r.asset_id,sha256:r.sha256,frameIndex:r.frame_index,seconds:r.seconds}))});
  await verifyPosePreviewInputs(client,manifest,{inputs:Object.fromEntries(contract.frameInputs.map((role,i)=>[role,ids[i]])),posePreviewSnapshot:snapshot},Object.values(assets),workspaceId,projectId,key=>store.file(workspaceId,key));return snapshot;
}

export async function verifyPosePreviewInputs(pool:Pool|PoolClient,manifest:CapabilityManifestV2,invocation:Pick<Invocation,"inputs"|"posePreviewSnapshot">,assets:InputAsset[],workspaceId:string,projectId:string,file:(key:string)=>Promise<string>){
  if(!manifest.posePreviewContract)return;
  const parsed=posePreviewSnapshotSchema.safeParse(invocation.posePreviewSnapshot);if(!parsed.success)throw new HttpError(422,"The prepared pose-frame receipt is missing or invalid.");
  const snapshot=parsed.data,roles=manifest.posePreviewContract.frameInputs;
  if(roles.length!==snapshot.frames.length)throw new HttpError(422,"The pose-frame count changed.");
  const source=(await pool.query("SELECT id,project_id,media_type,sha256,storage_key FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,snapshot.sourceAssetId])).rows[0];
  if(!source||source.media_type!=="video"||source.project_id!==projectId||source.sha256!==snapshot.sourceSha256||await fileSha256(await file(source.storage_key))!==snapshot.sourceSha256)throw new HttpError(422,"The driving source changed before pose processing.");
  for(const [i,frame]of snapshot.frames.entries()){
    const asset=assets.find(a=>a.id===frame.assetId);if(roles[i]!==frame.inputPort||invocation.inputs[frame.inputPort]!==frame.assetId||!asset||asset.project_id!==projectId||asset.media_type!=="image"||asset.sha256!==frame.sha256||await fileSha256(await file(asset.storage_key))!==frame.sha256)throw new HttpError(422,"A prepared driving frame changed before pose processing.");
  }
}

/** Preserve numeric model output together with its exact immutable source-frame lineage. */
export function posePreviewOutputMetadata(manifest:CapabilityManifestV2,invocation:Invocation,outputs:Record<string,unknown>){
  const contract=manifest.posePreviewContract;if(!contract)return undefined;
  const parsed=posePreviewSnapshotSchema.safeParse(invocation.posePreviewSnapshot);if(!parsed.success)throw new HttpError(422,"The prepared pose receipt is invalid.");
  const snapshot=parsed.data,value=outputs[contract.keypointNode] as {text?:unknown};
  if(!value||!Array.isArray(value.text)||value.text.length!==1||typeof value.text[0]!=="string"||value.text[0].length>512000)throw new HttpError(422,"Pose output is missing or oversized.");
  let decoded:unknown;try{decoded=JSON.parse(value.text[0]);}catch{throw new HttpError(422,"Pose output is not valid keypoint data.");}
  const poses=readPoseFrames(decoded,{count:snapshot.frames.length,width:snapshot.width,height:snapshot.height});if(!poses)throw new HttpError(422,"Pose output does not match the prepared driving frames.");
  return snapshot.frames.map((frame,i)=>({version:1,previewId:snapshot.previewId,sourceAssetId:snapshot.sourceAssetId,sourceSha256:snapshot.sourceSha256,normalizedSha256:snapshot.normalizedSha256,frameAssetId:frame.assetId,frameSha256:frame.sha256,frameIndex:frame.frameIndex,seconds:frame.seconds,fps:24,pose:poses[i]}));
}

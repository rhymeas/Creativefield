import type {CapabilityManifestV2,Invocation} from "../src/capabilities/types";
import {HttpError} from "./auth";
import {fileSha256,maskSnapshotSchema,maskReviewReceiptSchema} from "./masked-media";
import {approvedGeneratedMaskReview} from "./aligned-mask-admission";

export class AlignedMaskInputError extends HttpError{constructor(message:string){super(422,message);}}
/** Native preflight, also defensive if called by SDK code. This does not enable masked SDK transport. */
export async function verifyAlignedMaskInputs(manifest:CapabilityManifestV2,invocation:Invocation,assets:Array<{id:string;role:string;project_id:string|null;parent_id?:string|null;sha256:string;storage_key:string;metadata?:Record<string,unknown>}>,projectId:string,file:(key:string)=>Promise<string>){
  const contract=manifest.mediaContract;if(!contract)return;
  const parsed=maskSnapshotSchema.safeParse(invocation.mediaSnapshot);if(!parsed.success)throw new AlignedMaskInputError("Validated video mask receipt is missing or invalid.");
  const additional=contract.additionalMaskInputs??[],stored=invocation.additionalMaskSnapshots??{};
  if(Object.keys(stored).length!==additional.length||additional.some(role=>!stored[role]))throw new AlignedMaskInputError("Every additional mask needs an independent admission receipt.");
  const primary=parsed.data,source=assets.find(a=>a.role===contract.sourceInput);
  for(const role of [contract.maskInput,...additional]){
  const entry=role===contract.maskInput?{media:primary,review:invocation.maskReviewSnapshot}:stored[role],snapshotResult=maskSnapshotSchema.safeParse(entry?.media);
  if(!snapshotResult.success)throw new AlignedMaskInputError("Validated video mask receipt is missing or invalid.");const snapshot=snapshotResult.data,mask=assets.find(a=>a.role===role);
  if(["sourceAssetId","sourceSha256","width","height","frames","fps","timingDigest"].some(key=>snapshot[key as keyof typeof snapshot]!==primary[key as keyof typeof primary]))throw new AlignedMaskInputError("Additional mask no longer matches the shared source envelope.");
  if(!source||!mask||source.project_id!==projectId||mask.project_id!==projectId||source.id!==snapshot.sourceAssetId||source.id!==invocation.inputs[contract.sourceInput]||mask.id!==invocation.inputs[role]||source.sha256!==snapshot.sourceSha256||mask.sha256!==snapshot.maskSha256)throw new AlignedMaskInputError("Validated source or mask binding changed before execution.");
  try{
    const currentReview=approvedGeneratedMaskReview(mask,source),frozenReview=entry.review?maskReviewReceiptSchema.parse(entry.review):undefined;
    if(JSON.stringify(currentReview)!==JSON.stringify(frozenReview))throw new AlignedMaskInputError("Mask approval changed before execution.");
  }catch{throw new AlignedMaskInputError("Mask approval changed before execution.");}
  try{const [sourceHash,maskHash]=await Promise.all([file(source.storage_key).then(fileSha256),file(mask.storage_key).then(fileSha256)]);if(sourceHash!==snapshot.sourceSha256||maskHash!==snapshot.maskSha256)throw new AlignedMaskInputError("Validated source or mask changed before execution.");}
  catch(error){if(error instanceof AlignedMaskInputError)throw error;throw new AlignedMaskInputError("Validated source or mask is unavailable before execution.");}
  }
}

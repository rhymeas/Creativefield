import {z} from "zod";
import {HttpError} from "./auth";
import type {AlignedImageInputSnapshot} from "../src/capabilities/types";
import type {ImageInputContractV1} from "../src/capabilities/image-input-contract";
import type {ResolvedRunAsset} from "./element-inputs";

/**
 * The only receipt shape the server writes after strictly decoding an uploaded
 * PNG (see resources.ts). It proves decoded geometry and the semantic role the
 * bytes were uploaded under. It does not prove grayscale mask pixel content.
 */
export const imageValidationReceiptSchema=z.object({
  validationVersion:z.literal(1),format:z.literal("png"),
  width:z.number().int().positive(),height:z.number().int().positive(),
  hasAlpha:z.boolean(),semantic:z.enum(["image","mask","layer"]),
}).strict();
export type ImageValidationReceipt=z.infer<typeof imageValidationReceiptSchema>;

const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const alignedImageInputSnapshotSchema=z.object({
  validationVersion:z.literal(1),contract:z.literal("aligned_still_image_mask_v1"),
  sourceAssetId:z.uuid(),sourceSha256:digest,maskAssetId:z.uuid(),maskSha256:digest,
  width:z.number().int().positive(),height:z.number().int().positive(),
  dimensionMultiple:z.number().int().min(1).max(64),
  semantics:z.literal("white_edits_black_preserves"),
}).strict().refine(s=>s.width%s.dimensionMultiple===0&&s.height%s.dimensionMultiple===0);

function receiptFor(asset:ResolvedRunAsset|undefined,role:"source"|"mask",expectedSemantic:"image"|"mask"):ImageValidationReceipt{
  const label=role==="source"?"Source image":"Mask";
  if(!asset)throw new HttpError(422,`Aligned image input is missing its ${role} asset`);
  if(asset.media_type!==expectedSemantic||asset.content_type!=="image/png")throw new HttpError(422,`${label} must be a PNG uploaded as ${expectedSemantic}; upload it again`);
  const parsed=imageValidationReceiptSchema.safeParse(asset.metadata?.imageValidation);
  if(!parsed.success)throw new HttpError(422,`${label} is missing a valid server PNG validation receipt; upload it again`);
  if(parsed.data.semantic!==expectedSemantic)throw new HttpError(422,`${label} validation receipt has the wrong semantic role; upload it again as ${expectedSemantic}`);
  return parsed.data;
}

/**
 * Freeze an aligned still-image/mask admission receipt from server-owned upload
 * validation receipts only. Caller-resolved assets already carry the project
 * and workspace ownership guarantees of input resolution. Throws before any
 * run is created when receipts are missing, forged, or geometrically
 * incompatible with the manifest contract.
 */
export function admitAlignedImageInputs(contract:ImageInputContractV1,assets:Record<string,ResolvedRunAsset>):AlignedImageInputSnapshot{
  if(!contract||contract.kind!=="aligned_still_image_mask_v1"||contract.schemaVersion!==1
    ||contract.semantics!=="white_edits_black_preserves"
    ||!Number.isSafeInteger(contract.dimensionMultiple)||contract.dimensionMultiple<1||contract.dimensionMultiple>64
    ||!contract.sourceInput||!contract.maskInput||contract.sourceInput===contract.maskInput){
    throw new HttpError(422,"Aligned image input contract is invalid");
  }
  const source=assets[contract.sourceInput],mask=assets[contract.maskInput];
  const sourceReceipt=receiptFor(source,"source","image");
  const maskReceipt=receiptFor(mask,"mask","mask");
  if(sourceReceipt.width!==maskReceipt.width||sourceReceipt.height!==maskReceipt.height){
    throw new HttpError(422,"Source image and mask must have identical width and height");
  }
  const multiple=contract.dimensionMultiple;
  if(sourceReceipt.width%multiple!==0||sourceReceipt.height%multiple!==0){
    throw new HttpError(422,`Source image and mask width and height must each be divisible by ${multiple}`);
  }
  return {
    validationVersion:1,contract:"aligned_still_image_mask_v1",
    sourceAssetId:source.id,sourceSha256:source.sha256,
    maskAssetId:mask.id,maskSha256:mask.sha256,
    width:sourceReceipt.width,height:sourceReceipt.height,
    dimensionMultiple:multiple,semantics:contract.semantics,
  };
}

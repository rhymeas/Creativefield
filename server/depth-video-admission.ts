import { HttpError } from "./auth";
import { assertGrayscaleDepthControl, fileSha256, inspectMaskVideo, withMaskInspection } from "./masked-media";
import type { DepthAlignmentSnapshotV1 } from "../src/capabilities/types";
import {z} from "zod";

type DepthVideoAsset = { id: string; project_id: string | null; media_type: string; content_type: string; sha256: string };
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export class EffectInputValidationError extends HttpError{constructor(message:string){super(422,message);}}
export const depthAlignmentSnapshotSchema=z.object({validationVersion:z.literal(1),sourceAssetId:z.uuid(),sourceSha256:digest,depthAssetId:z.uuid(),depthSha256:digest,width:z.number().int().positive(),height:z.number().int().positive(),fps:z.literal(16),frames:z.number().int().min(17).max(81),timingDigest:digest,depthEncoding:z.literal("grayscale_rgb8")}).strict().refine(v=>v.width*v.height<=399360);

/** Both transports call this before the first worker upload. */
export async function verifyEffectInputs(capabilityId:string,invocation:{inputs:Record<string,string>;depthAlignmentSnapshot?:unknown},assets:Array<DepthVideoAsset&{role:string;storage_key:string}>,projectId:string,file:(key:string)=>Promise<string>){
  if(!["vace-depth-restyle","vace-canny-restyle"].includes(capabilityId))return;
  const source=assets.find(a=>a.role==="source_video");
  if(!source||source.id!==invocation.inputs.source_video||source.project_id!==projectId||source.media_type!=="video"||!source.content_type.startsWith("video/")||await fileSha256(await file(source.storage_key))!==source.sha256)throw new EffectInputValidationError("The selected effect source changed before execution. Upload it again.");
  if(capabilityId==="vace-canny-restyle")return;
  const parsed=depthAlignmentSnapshotSchema.safeParse(invocation.depthAlignmentSnapshot),depth=assets.find(a=>a.role==="depth_video");
  if(!parsed.success||!depth||depth.id!==invocation.inputs.depth_video||parsed.data.sourceAssetId!==source.id||parsed.data.sourceSha256!==source.sha256||parsed.data.depthAssetId!==depth.id||parsed.data.depthSha256!==depth.sha256)throw new EffectInputValidationError("The frozen source/depth receipt no longer matches this run. Upload aligned inputs again.");
  let current:DepthAlignmentSnapshotV1;
  try{current=await admitAlignedDepthVideo(source,depth,await file(source.storage_key),await file(depth.storage_key),projectId);}catch(error){if(error instanceof HttpError)throw new EffectInputValidationError(error.message);throw error;}
  if(Object.keys(parsed.data).some(key=>current[key as keyof DepthAlignmentSnapshotV1]!==parsed.data[key as keyof DepthAlignmentSnapshotV1]))throw new EffectInputValidationError("The validated source/depth timeline changed before execution. Upload aligned inputs again.");
}

/** Verify the decoded source/depth timeline and freeze both media identities before a VACE run is admitted. */
export async function admitAlignedDepthVideo(source: DepthVideoAsset, depth: DepthVideoAsset, sourcePath: string, depthPath: string, projectId: string): Promise<DepthAlignmentSnapshotV1> {
  if (source.project_id !== projectId || depth.project_id !== projectId || source.media_type !== "video" || depth.media_type !== "video" || !source.content_type.startsWith("video/") || !depth.content_type.startsWith("video/")) {
    throw new HttpError(422, "Choose source and depth videos from this project");
  }
  if (await fileSha256(sourcePath) !== source.sha256 || await fileSha256(depthPath) !== depth.sha256) throw new HttpError(422, "A source or depth video changed since upload; upload it again");

  return withMaskInspection(async () => {
    const sourceFacts = await inspectMaskVideo(sourcePath);
    const depthFacts = await inspectMaskVideo(depthPath);
    if (depthFacts.hasAudio) throw new HttpError(422, "Preprocessed depth videos must not contain audio");
    if (sourceFacts.width !== depthFacts.width || sourceFacts.height !== depthFacts.height || sourceFacts.frames !== depthFacts.frames || sourceFacts.timingDigest !== depthFacts.timingDigest) {
      throw new HttpError(422, "Preprocessed depth must match the source dimensions, frame count, and every frame timestamp");
    }
    await assertGrayscaleDepthControl(depthPath, depthFacts.width, depthFacts.height, depthFacts.frames);
    if (await fileSha256(sourcePath) !== source.sha256 || await fileSha256(depthPath) !== depth.sha256) throw new HttpError(422, "A source or depth video changed during validation; upload it again");
    return {
      validationVersion: 1,
      sourceAssetId: source.id,
      sourceSha256: source.sha256,
      depthAssetId: depth.id,
      depthSha256: depth.sha256,
      width: sourceFacts.width,
      height: sourceFacts.height,
      fps: 16,
      frames: sourceFacts.frames,
      timingDigest: sourceFacts.timingDigest,
      depthEncoding: "grayscale_rgb8",
    };
  });
}

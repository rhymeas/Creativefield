import type {CapabilityManifestV2} from "./types";
import {isVideoProbe} from "./replace-video-probe";

/** The reference clip a tool runs on, and the rate that copy is made ready at. */
export type CleanSourceRule={
  sourceInput:string;
  /** The rate the tool's graph takes; the copy keeps the clip's own rate when it has none. */
  fps?:16|24;
  /** Masked edits: the masks name the source they were measured on. */
  maskInputs?:string[];
};

/** Tools that take a reference clip and change it, in the order their contracts name the clip. */
export function cleanSourceRule(manifest:CapabilityManifestV2):CleanSourceRule|undefined{
  if(isVideoProbe(manifest.id))return {sourceInput:"source_video",fps:24};
  if(manifest.replaceContract)return {sourceInput:manifest.replaceContract.sourceInput,fps:24};
  if(manifest.motionContract)return {sourceInput:manifest.motionContract.motionInput,fps:24};
  if(manifest.fpsPrepare)return {sourceInput:manifest.fpsPrepare.sourceInput,fps:16};
  if(manifest.mediaContract)return {sourceInput:manifest.mediaContract.sourceInput,fps:16,maskInputs:[manifest.mediaContract.maskInput,...(manifest.mediaContract.additionalMaskInputs??[])]};
  if(manifest.outputContract)return {sourceInput:manifest.outputContract.sourceInput,fps:16};
  /* An ordinary clip tool: one video input and no mask, motion or tracking contract. Enhancement
     packs (upscale, interpolation) make the clip it already is bigger; they are not cleaned. */
  const videoInputs=manifest.inputs.filter(port=>port.type==="video");
  if(!videoInputs.length||videoInputs.length>1)return undefined;
  if(!["motion","finishing","video"].includes(manifest.category))return undefined;
  return {sourceInput:videoInputs[0].id};
}

/** A mask rides on the clip it was measured on: the crop may replace the source only when every
 *  mask's receipt names the clean copy, so a mask made on the full frame keeps its own source. */
export function maskNamesSource(metadata:Record<string,unknown>|undefined,cleaned:{id:string;sha256:string}):boolean{
  const sequence=metadata?.maskSequence as {sourceAssetId?:unknown;sourceSha256?:unknown}|undefined;
  if(sequence?.sourceAssetId===cleaned.id&&sequence?.sourceSha256===cleaned.sha256)return true;
  const normalization=metadata?.maskNormalization as {originalSourceAssetId?:unknown;originalSourceSha256?:unknown}|undefined;
  return normalization?.originalSourceAssetId===cleaned.id&&normalization?.originalSourceSha256===cleaned.sha256;
}

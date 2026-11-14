import type {MaskSequenceSnapshot,CapabilityManifestV2} from "../capabilities/types";
import {assetMatchesPort} from "../capabilities/assets";
import type {Asset} from "./api";

export function isMaskedEdit(manifest:CapabilityManifestV2|undefined){
  return manifest?.mediaContract?.kind==="aligned_video_mask_v1"&&!manifest.mediaContract.additionalMaskInputs?.length;
}

export function maskSnapshot(asset:Asset|undefined):MaskSequenceSnapshot|null {
  const value=asset?.metadata?.maskSequence as Partial<MaskSequenceSnapshot>|undefined;
  return value?.validationVersion===1&&value.semantics==="white_edits_black_preserves"&&typeof value.sourceAssetId==="string"&&typeof value.sourceSha256==="string"&&typeof value.maskSha256==="string"&&typeof value.frames==="number"&&value.fps===16?value as MaskSequenceSnapshot:null;
}

export function matchingMask(asset:Asset,source:Asset|undefined,projectId:string,manifest:CapabilityManifestV2){
  if(!source||!manifest.mediaContract)return false;
  const port=manifest.inputs.find(p=>p.id===manifest.mediaContract!.maskInput);
  const receipt=maskSnapshot(asset);
  return !!port&&assetMatchesPort(asset,port)&&asset.project_id===projectId&&asset.parent_id===source.id&&!!asset.sha256&&!!source.sha256&&receipt?.sourceAssetId===source.id&&receipt.sourceSha256===source.sha256&&receipt.maskSha256===asset.sha256;
}

export function clearMaskForSource(inputs:Record<string,string>,manifest:CapabilityManifestV2){
  if(!manifest.mediaContract)return inputs;
  const next={...inputs};delete next[manifest.mediaContract.maskInput];return next;
}

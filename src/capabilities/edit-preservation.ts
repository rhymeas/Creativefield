import type {CapabilityBundle} from "./types";
export type PreservationQA={
  method:"srgb8-max-channel-v1";channelTolerance:2;excludedMask:"effective mask > 0/255";
  driftTolerancePercent:0.1;protectedPixels:number;changedProtectedPixels:number;
  driftPercent:number|null;maxChannelDelta:number;meanChannelDelta:number|null;withinTolerance:boolean;
  width:number;height:number;
};
export type PreservationRecord={kind:"klein_still_v1";sourceAssetId:string;candidateAssetId:string;finalAssetId:string;effectiveMaskAssetId:string;
  report:string;upstream:{klein:string;cropStitch:string};qa:PreservationQA};

export type EditPreservationContract={
  kind:"klein_still_v1";sourceInput:string;maskInput:string;
  finalArtifact:string;candidateArtifact:string;maskArtifact:string;
  reportNode:string;kleinNode:string;cropNode:string;
  upstream:{klein:string;cropStitch:string};
};

/** Trusted workflow declaration, not a claim inferred from a model name. */
export function validateEditPreservation(bundle:CapabilityBundle):string[]{
  const c=bundle.manifest.editPreservation;if(!c)return [];
  const m=bundle.manifest,g=bundle.template,a=m.imageArtifacts?.artifacts??[];
  const errors:string[]=[];
  if(c.kind!=="klein_still_v1"||m.imageInputContract?.sourceInput!==c.sourceInput||m.imageInputContract.maskInput!==c.maskInput)
    errors.push("Invalid preservation source/mask contract");
  for(const [id,role] of [[c.finalArtifact,"image"],[c.candidateArtifact,"image"],[c.maskArtifact,"mask"]])
    if(!a.some(item=>item.id===id&&item.role===role&&item.dimensions.mode==="match_input"&&item.dimensions.inputPort===c.sourceInput))errors.push("Invalid preservation artifact: "+id);
  if(new Set([c.finalArtifact,c.candidateArtifact,c.maskArtifact]).size!==3)errors.push("Preservation artifacts must be distinct");
  if(g?.[c.kleinNode]?.class_type!=="KleinEditComposite"||g?.[c.reportNode]?.class_type!=="PreviewAny"
    ||JSON.stringify(g[c.reportNode].inputs.source)!==JSON.stringify([c.kleinNode,2]))errors.push("Invalid upstream Klein/report wiring");
  if(g?.[c.cropNode]?.class_type!=="InpaintCrop"||g[c.cropNode].inputs.mode!=="forced size")errors.push("Invalid preservation crop policy");
  if(!/^[a-f0-9]{40}$/.test(c.upstream?.klein??"")||!/^[a-f0-9]{40}$/.test(c.upstream?.cropStitch??""))errors.push("Preservation dependency revisions must be pinned");
  return errors;
}

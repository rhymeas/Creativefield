import {z} from "zod";

export type TrackingPoint={x:number;y:number;kind:"include"|"exclude"};
export type TrackingSourceSnapshot={assetId:string;projectId:string;sha256:string;width:number;height:number;fps:16;frames:number;timingDigest:string};
export type TrackingSelection={sourceAssetId:string;sourceSha256:string;projectId:string;frameIndex:0;objectIndex:1;points:TrackingPoint[]};

export const MAX_TRACKING_POINTS=32;

const trackingPointSchema=z.object({
  x:z.number().finite().nonnegative(),
  y:z.number().finite().nonnegative(),
  kind:z.enum(["include","exclude"]),
}).strict();

/** Public requests contain only user intent. Asset identities, hashes, media
 * geometry and workflow/checkpoint evidence are always derived by the server. */
export const pointsTrackingRequestSchema=z.object({
  frameIndex:z.literal(0),
  objectIndex:z.literal(1),
  points:z.array(trackingPointSchema).min(1).max(MAX_TRACKING_POINTS),
}).strict().refine(value=>value.points.some(point=>point.kind==="include"),{
  message:"Add at least one include point",
  path:["points"],
});
/** SAM 3.1 tracks with a short object phrase instead of frame-zero points. */
export const promptTrackingRequestSchema=z.object({
  prompt:z.string().trim().min(2).max(200),
}).strict();
export const trackingRequestSchema=z.union([pointsTrackingRequestSchema,promptTrackingRequestSchema]);
export type TrackingRequest=z.infer<typeof trackingRequestSchema>;
export type PointsTrackingRequest=z.infer<typeof pointsTrackingRequestSchema>;
export type PromptTrackingRequest=z.infer<typeof promptTrackingRequestSchema>;
export const trackingRequestMode=(request:TrackingRequest):"points"|"prompt"=>"prompt" in request?"prompt":"points";

/** Stable JSON accepted by the pinned SAM 2 node. Point order is preserved
 * because it is part of the submitted user intent. */
export function canonicalTrackingControls(points:TrackingPoint[]):{include_points:string;exclude_points:string}{
  const encode=(kind:TrackingPoint["kind"])=>JSON.stringify(points.filter(point=>point.kind===kind).map(({x,y})=>({x,y})));
  return {include_points:encode("include"),exclude_points:encode("exclude")};
}

/** Admission invariants for EDT-01a. Ownership, role and database freshness are
 * checked by the eventual route before this pure validator is called. */
export function validateTrackingSelection(selection:TrackingSelection,source:TrackingSourceSnapshot):string[] {
  const errors:string[]=[];
  if(selection.sourceAssetId!==source.assetId||selection.sourceSha256!==source.sha256||selection.projectId!==source.projectId)errors.push("Source snapshot changed");
  if(selection.frameIndex!==0)errors.push("Points must be placed on frame zero");
  if(selection.objectIndex!==1)errors.push("Only one tracked object is supported");
  const points=Array.isArray(selection.points)?selection.points:[];
  if(points.length===0||points.length>MAX_TRACKING_POINTS)errors.push(`Use 1 to ${MAX_TRACKING_POINTS} points`);
  if(!points.some(point=>point!=null&&point.kind==="include"))errors.push("Add at least one include point");
  for(const point of points){
    if(point==null||!Number.isFinite(point.x)||!Number.isFinite(point.y)||!(["include","exclude"] as const).includes(point.kind)||point.x<0||point.y<0||point.x>=source.width||point.y>=source.height)errors.push("Point is outside the source frame");
  }
  return [...new Set(errors)];
}

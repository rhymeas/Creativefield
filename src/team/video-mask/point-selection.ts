export type VideoTrackingPoint={x:number;y:number;kind:"include"|"exclude"};
export type PointTrackingSelection={frameIndex:0;objectIndex:1;points:VideoTrackingPoint[]};
export const MAX_VIDEO_TRACKING_POINTS=32;
export function validTrackingPoints(points:unknown):points is VideoTrackingPoint[]{
  return Array.isArray(points)&&points.length>0&&points.length<=MAX_VIDEO_TRACKING_POINTS&&points.some(p=>p?.kind==="include")&&points.every(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<832&&p.y>=0&&p.y<832&&["include","exclude"].includes(p.kind));
}
export function pointAtFrame(clientX:number,clientY:number,bounds:{left:number;top:number;width:number;height:number},width:number,height:number,kind:VideoTrackingPoint["kind"]):VideoTrackingPoint|null{
  if(![clientX,clientY,bounds.left,bounds.top,bounds.width,bounds.height,width,height].every(Number.isFinite)||bounds.width<=0||bounds.height<=0||width<1||height<1)return null;
  const x=(clientX-bounds.left)/bounds.width,y=(clientY-bounds.top)/bounds.height;
  if(x<0||x>1||y<0||y>1)return null;
  return {x:Math.min(width-1,Math.floor(x*width)),y:Math.min(height-1,Math.floor(y*height)),kind};
}

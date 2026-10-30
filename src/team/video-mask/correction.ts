export type MaskPatch={start:number;end:number;x:number;y:number;width:number;height:number;mode:"add"|"subtract"};
export const MAX_MASK_PATCHES=64;
/** Shared integer pixel rectangles; ranges are inclusive, never implicitly propagated. */
export function validMaskPatch(p:MaskPatch,g:{width:number;height:number;frames:number}){
  return [p.start,p.end,p.x,p.y,p.width,p.height].every(Number.isInteger)&&p.start>=0&&p.end>=p.start&&p.end<g.frames&&p.x>=0&&p.y>=0&&p.width>0&&p.height>0&&p.x+p.width<=g.width&&p.y+p.height<=g.height&&(p.mode==="add"||p.mode==="subtract");
}
export function maskRectangle(a:{x:number;y:number},b:{x:number;y:number},g:{width:number;height:number}){
  const x=Math.max(0,Math.min(g.width-1,Math.floor(Math.min(a.x,b.x)))),y=Math.max(0,Math.min(g.height-1,Math.floor(Math.min(a.y,b.y))));
  return {x,y,width:Math.min(g.width-x,Math.max(1,Math.ceil(Math.max(a.x,b.x))-x)),height:Math.min(g.height-y,Math.max(1,Math.ceil(Math.max(a.y,b.y))-y))};
}

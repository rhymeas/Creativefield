import {blankCanvas,sizeOf,type Bitmap} from "./bitmaps";
export type Edge=[number,number,number,number];
/** Exposed pixel boundaries, including holes. The mask itself is never modified. */
export function maskEdges(data:Uint8ClampedArray,w:number,h:number,threshold=8):Edge[]{
  if(data.length!==w*h*4)throw new Error("Invalid mask dimensions");
  const edges:Edge[]=[],at=(x:number,y:number)=>x>=0&&y>=0&&x<w&&y<h&&data[(y*w+x)*4+3]>threshold;
  for(let y=0;y<=h;y++){
    let start=-1;
    for(let x=0;x<=w;x++){
      const edge=x<w&&at(x,y-1)!==at(x,y);
      if(edge&&start<0)start=x;
      if(!edge&&start>=0){edges.push([start,y,x,y]);start=-1;}
    }
  }
  for(let x=0;x<=w;x++){
    let start=-1;
    for(let y=0;y<=h;y++){
      const edge=y<h&&at(x-1,y)!==at(x,y);
      if(edge&&start<0)start=y;
      if(!edge&&start>=0){edges.push([x,start,x,y]);start=-1;}
    }
  }
  return edges;
}
const cache=new WeakMap<Bitmap,{revision:number;path:Path2D}>();
export function drawMaskOutline(ctx:CanvasRenderingContext2D,bitmap:Bitmap,revision:number,pixel:number,light:string,dark:string,phase=0){
  let entry=cache.get(bitmap);
  if(!entry||entry.revision!==revision){
    const {w,h}=sizeOf(bitmap),copy=blankCanvas(w,h),c=copy.getContext("2d",{willReadFrequently:true})!;c.drawImage(bitmap,0,0);
    const path=new Path2D();for(const [x,y,x2,y2] of maskEdges(c.getImageData(0,0,w,h).data,w,h)){path.moveTo(x,y);path.lineTo(x2,y2);}
    entry={revision,path};cache.set(bitmap,entry);
  }
  ctx.save();ctx.lineWidth=2*pixel;ctx.strokeStyle=dark;ctx.stroke(entry.path);
  ctx.lineWidth=pixel;ctx.strokeStyle=light;ctx.setLineDash([3*pixel,3*pixel]);ctx.lineDashOffset=-phase*pixel;ctx.stroke(entry.path);ctx.restore();
}

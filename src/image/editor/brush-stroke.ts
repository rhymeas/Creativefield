import {blankCanvas} from "./bitmaps";

/** Flow accumulates in paint; opacity is applied once against the frozen stroke base. */
export type BrushStroke={base:HTMLCanvasElement;paint:HTMLCanvasElement;clipped:HTMLCanvasElement|null;selection:HTMLCanvasElement|null};
export function createBrushStroke(target:HTMLCanvasElement,selection:HTMLCanvasElement|null=null):BrushStroke{
  const base=blankCanvas(target.width,target.height);base.getContext("2d")!.drawImage(target,0,0);
  return {base,paint:blankCanvas(target.width,target.height),selection,clipped:selection?blankCanvas(target.width,target.height):null};
}
export function compositeBrushStroke(target:HTMLCanvasElement,stroke:BrushStroke,opacity:number,mode:GlobalCompositeOperation){
  let paint=stroke.paint;
  if(stroke.selection&&stroke.clipped){
    const clip=stroke.clipped.getContext("2d")!;clip.clearRect(0,0,paint.width,paint.height);clip.drawImage(paint,0,0);
    clip.globalCompositeOperation="destination-in";clip.drawImage(stroke.selection,0,0);clip.globalCompositeOperation="source-over";paint=stroke.clipped;
  }
  const ctx=target.getContext("2d")!;ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.globalCompositeOperation="source-over";
  ctx.clearRect(0,0,target.width,target.height);ctx.drawImage(stroke.base,0,0);
  ctx.globalAlpha=Math.max(0,Math.min(1,opacity/100));ctx.globalCompositeOperation=mode;ctx.drawImage(paint,0,0);ctx.restore();
}

export const brushEdgeBlur=(size:number,hardness:number)=>Math.max(0,size*.08*(1-Math.max(0,Math.min(100,hardness))/100));

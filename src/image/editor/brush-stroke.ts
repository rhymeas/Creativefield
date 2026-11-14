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

const alphaColor=(color:string,alpha:number)=>{
  const hex=color.match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  if(!hex)return color;
  const full=hex.length===3?hex.split("").map(value=>value+value).join(""):hex;
  const [r,g,b]=[0,2,4].map(offset=>Number.parseInt(full.slice(offset,offset+2),16));
  return `rgba(${r},${g},${b},${alpha})`;
};

/** A zero-hardness dab: opaque in the middle, continuously fading to clear at its true radius. */
export function paintSuperSoftRound(ctx:CanvasRenderingContext2D,x:number,y:number,size:number,color:string,hardness=0){
  const radius=Math.max(.5,size/2),hard=Math.max(0,Math.min(100,hardness))/100;
  const inner=Math.min(.82,hard*.72);
  const gradient=ctx.createRadialGradient(x,y,0,x,y,radius);
  gradient.addColorStop(0,alphaColor(color,1));
  if(inner>0)gradient.addColorStop(inner,alphaColor(color,1));
  gradient.addColorStop(inner+(1-inner)*.5,alphaColor(color,.32));
  gradient.addColorStop(inner+(1-inner)*.78,alphaColor(color,.08));
  gradient.addColorStop(1,alphaColor(color,0));
  ctx.fillStyle=gradient;ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fill();
}

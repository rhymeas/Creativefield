import {effectiveLayerMaskKey} from "./layer-mask";
import {blankCanvas,getBitmap,setBitmap} from "./bitmaps";
import {newId,type Doc} from "./doc";
import type {CropRect} from "./crop";

export function normalizeViewport(rect:CropRect,generation=true):CropRect{
  const x=Math.round(rect.x),y=Math.round(rect.y),w=generation?Math.floor(rect.w/8)*8:Math.round(rect.w),h=generation?Math.floor(rect.h/8)*8:Math.round(rect.h);
  if(![x,y,w,h].every(Number.isFinite)||w<(generation?8:1)||h<(generation?8:1)||w>(generation?2048:32768)||h>(generation?2048:32768)||w*h>67108864)throw new Error(generation?"Generated crop dimensions must be 8–2048 pixels per side.":"Crop dimensions exceed the canvas limit.");
  return {x,y,w,h};
}
export function hasExposedBorder(rect:CropRect,w:number,h:number){return rect.x<0||rect.y<0||rect.x+rect.w>w||rect.y+rect.h>h;}
/** Document-space masks move with the viewport; intrinsic layer pixels do not change. */
export function cropViewport(doc:Doc,rect:CropRect):Doc{
  const moved=new Map<string,string>();
  const shift=(key:string)=>{
    const cached=moved.get(key);if(cached)return cached;
    const bitmap=getBitmap(key);if(!bitmap)throw new Error("A document mask is not loaded yet.");
    const canvas=blankCanvas(rect.w,rect.h);canvas.getContext("2d")!.drawImage(bitmap,-rect.x,-rect.y);
    const next=newId("bmp:crop-mask:");setBitmap(next,canvas);moved.set(key,next);return next;
  };
  return {...doc,width:rect.w,height:rect.h,selection:null,saved:doc.saved?.map(s=>({...s,key:shift(s.key)})),
    layers:doc.layers.map(l=>({...l,x:l.x-rect.x,y:l.y-rect.y,...(l.mask?{mask:shift(effectiveLayerMaskKey(doc,l)!),maskAnchor:undefined}:{})}))};
}
/** Resize the cropped document uniformly while keeping layer editability and document masks. */
export function scaleViewport(doc:Doc,percent:number):Doc{
  if(!Number.isFinite(percent)||percent<10||percent>800)throw new Error("Scale must be between 10% and 800%.");
  const factor=percent/100,width=Math.round(doc.width*factor),height=Math.round(doc.height*factor);
  if(width<1||height<1||width>2048||height>2048||width*height>67108864)throw new Error("Scaled canvas must be no larger than 2048 px per side.");
  const scaled=new Map<string,string>();
  const scaleMask=(key:string|null|undefined):string|null|undefined=>{
    if(!key)return undefined;
    const known=scaled.get(key);if(known)return known;
    const bitmap=getBitmap(key);if(!bitmap)throw new Error("A document mask is not loaded yet.");
    const canvas=blankCanvas(width,height);canvas.getContext("2d")!.drawImage(bitmap,0,0,width,height);
    const next=newId("bmp:scale-mask:");setBitmap(next,canvas);scaled.set(key,next);return next;
  };
  return {...doc,width,height,selection:scaleMask(doc.selection)??null,saved:doc.saved?.map(item=>({...item,key:scaleMask(item.key)!})),
    layers:doc.layers.map(layer=>({...layer,x:layer.x*factor,y:layer.y*factor,w:layer.w*factor,h:layer.h*factor,
      ...(layer.mask?{mask:scaleMask(layer.mask) as string,maskAnchor:undefined}:{})}))};
}
/** Alpha only on pixels newly exposed by the crop, never on the old canvas. */
export function exposedBorder(doc:Doc,rect:CropRect):HTMLCanvasElement{
  const mask=blankCanvas(rect.w,rect.h),c=mask.getContext("2d")!;c.fillStyle="#fff";c.fillRect(0,0,rect.w,rect.h);
  c.clearRect(-rect.x,-rect.y,doc.width,doc.height);return mask;
}

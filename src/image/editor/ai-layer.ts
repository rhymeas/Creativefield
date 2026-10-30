import {blankCanvas,getBitmap,sizeOf,type Bitmap} from "./bitmaps";
import {addPaintLayer,isVisible,moveLayerToEdge,selectedLayer,type Doc} from "./doc";
import {layerCanvas,renderDoc} from "./render";
import {coverSource,type Rect} from "./ai";

export type ModifyMatte={canvas:HTMLCanvasElement;bounds:Rect};

/** An integration patch has room for corrected perspective and contact shadows.
 * Its boundary follows the surrounding composite alpha, not the old element silhouette. */
export function harmonizePatch(doc:Doc):{matte:ModifyMatte;target:HTMLCanvasElement;region:Rect}{
  const target=freezeModifyMatte({...doc,selection:null}),b=target.bounds;
  const pad=Math.round(Math.max(b.w,b.h)*.5),x=Math.max(0,b.x-pad),y=Math.max(0,b.y-pad);
  const region={x,y,w:Math.min(doc.width,b.x+b.w+pad)-x,h:Math.min(doc.height,b.y+b.h+pad)-y};
  // Show broader scene context to the model, but allow a smaller local integration patch.
  const room=Math.max(8,Math.round(Math.max(b.w,b.h)*.2)),left=Math.max(x,b.x-room),top=Math.max(y,b.y-room);
  const bounds={x:left,y:top,w:Math.min(x+region.w,b.x+b.w+room)-left,h:Math.min(y+region.h,b.y+b.h+room)-top};
  const canvas=blankCanvas(doc.width,doc.height);renderDoc(canvas.getContext("2d")!,{...doc,selection:null});
  const ctx=canvas.getContext("2d")!;ctx.globalCompositeOperation="destination-in";ctx.fillStyle="#fff";
  const clip=blankCanvas(doc.width,doc.height);clip.getContext("2d")!.fillRect(left,top,bounds.w,bounds.h);ctx.drawImage(clip,0,0);
  const feather=Math.max(1,Math.min(16,Math.floor(Math.min(bounds.w,bounds.h)*.08)));
  for(const horizontal of [true,false]){
    const length=horizontal?bounds.w:bounds.h,gradient=ctx.createLinearGradient(left,top,horizontal?left+bounds.w:left,horizontal?top:top+bounds.h);
    gradient.addColorStop(0,"transparent");gradient.addColorStop(feather/length,"white");gradient.addColorStop(1-feather/length,"white");gradient.addColorStop(1,"transparent");
    ctx.fillStyle=gradient;ctx.fillRect(left,top,bounds.w,bounds.h);
  }
  return {matte:{canvas,bounds},target:target.canvas,region};
}

/** Freeze the element's document-space alpha before the asynchronous model run. */
export function freezeModifyMatte(doc:Doc,scope:"layer"|"composite"="layer"):ModifyMatte{
  const layer=scope==="composite"?null:selectedLayer(doc);
  let canvas:HTMLCanvasElement;
  if(layer&&layer.kind!=="adjust"){
    if(layer.mask&&!layer.maskOff&&!getBitmap(layer.mask))throw new Error("The layer mask is not loaded yet.");
    const pixels=layerCanvas(doc,layer);
    if(!pixels)throw new Error("The selected layer is not loaded yet.");
    canvas=pixels;
    if(layer.clip){
      const index=doc.layers.findIndex(l=>l.id===layer.id);
      const base=doc.layers.slice(0,index).reverse().find(l=>l.kind!=="adjust"&&!l.clip&&isVisible(doc,l));
      const shape=base&&layerCanvas(doc,base);
      if(!shape)throw new Error("The clipping layer is not available.");
      const ctx=canvas.getContext("2d")!;ctx.globalCompositeOperation="destination-in";ctx.drawImage(shape,0,0);
    }
    if(layer.opacity!==1){
      const faded=blankCanvas(doc.width,doc.height),ctx=faded.getContext("2d")!;
      ctx.globalAlpha=layer.opacity;ctx.drawImage(canvas,0,0);ctx.globalAlpha=1;canvas=faded;
    }
  }else{
    canvas=blankCanvas(doc.width,doc.height);renderDoc(canvas.getContext("2d")!,{...doc,selection:null});
  }
  if(doc.selection){
    const selection=getBitmap(doc.selection);if(!selection)throw new Error("The selection is not loaded yet.");
    const ctx=canvas.getContext("2d")!;ctx.globalCompositeOperation="destination-in";ctx.drawImage(selection,0,0);
  }
  const data=canvas.getContext("2d",{willReadFrequently:true})!.getImageData(0,0,doc.width,doc.height).data;
  let x0=doc.width,y0=doc.height,x1=-1,y1=-1;
  for(let y=0;y<doc.height;y++)for(let x=0;x<doc.width;x++)if(data[(y*doc.width+x)*4+3]>0){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
  if(x1<0)throw new Error("The selected element has no visible pixels to modify.");
  return {canvas,bounds:{x:x0,y:y0,w:x1-x0+1,h:y1-y0+1}};
}

/** Model RGB is allowed to change; original holes, mask edges and placement are not. */
export function cutoutModifiedResult(bitmap:Bitmap,region:Rect,matte:ModifyMatte):HTMLCanvasElement{
  const full=blankCanvas(matte.canvas.width,matte.canvas.height),ctx=full.getContext("2d")!;
  const size=sizeOf(bitmap),src=coverSource(size.w,size.h,region);
  ctx.drawImage(bitmap,src.x,src.y,src.w,src.h,region.x,region.y,region.w,region.h);
  ctx.globalCompositeOperation="destination-in";ctx.drawImage(matte.canvas,0,0);
  const b=matte.bounds,cropped=blankCanvas(b.w,b.h);
  cropped.getContext("2d")!.drawImage(full,b.x,b.y,b.w,b.h,0,0,b.w,b.h);
  return cropped;
}

export function addAiResultLayer(doc:Doc,key:string,name:string,bounds:Rect={x:0,y:0,w:doc.width,h:doc.height}):Doc{
  const added=addPaintLayer(doc,key);
  return moveLayerToEdge({...added,layers:added.layers.map(l=>l.id===added.selectedId?{...l,name,w:bounds.w,h:bounds.h,x:bounds.x+bounds.w/2,y:bounds.y+bounds.h/2}:l)},added.selectedId!,"top");
}

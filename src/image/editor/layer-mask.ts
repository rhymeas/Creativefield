import {blankCanvas,getBitmap,setBitmap,type Bitmap} from "./bitmaps";
import {newId,type Doc,type Layer} from "./doc";
const cache=new WeakMap<Layer,{source:Bitmap;width:number;height:number;canvas:HTMLCanvasElement}>();
/** Original mask pixels stay immutable; geometry follows the layer without repeated resampling. */
export function effectiveLayerMask(doc:Pick<Doc,"width"|"height">,layer:Layer):Bitmap|undefined{
  const source=layer.mask?getBitmap(layer.mask):undefined,anchor=layer.maskAnchor;if(!source||!anchor)return source;
  const old=cache.get(layer);if(old?.source===source&&old.width===doc.width&&old.height===doc.height)return old.canvas;
  const canvas=blankCanvas(doc.width,doc.height),ctx=canvas.getContext("2d")!;
  ctx.translate(layer.x,layer.y);ctx.rotate(layer.rotation*Math.PI/180);
  ctx.scale(layer.scale/anchor.scale*(layer.flipX===anchor.flipX?1:-1),layer.scale/anchor.scale);
  ctx.rotate(-anchor.rotation*Math.PI/180);ctx.translate(-anchor.x,-anchor.y);ctx.drawImage(source,0,0);
  cache.set(layer,{source,width:doc.width,height:doc.height,canvas});return canvas;
}
/** Editing a mask explicitly bakes its current canvas-space view into a fresh bitmap. */
export function cloneLayerMask(doc:Pick<Doc,"width"|"height">,layer:Layer){
  const source=effectiveLayerMask(doc,layer);if(!source)throw Error("The layer mask is not loaded.");
  const canvas=blankCanvas(doc.width,doc.height);canvas.getContext("2d")!.drawImage(source,0,0);
  const key=newId("bmp:mask:");setBitmap(key,canvas);return {key,canvas};
}
export const effectiveLayerMaskKey=(doc:Pick<Doc,"width"|"height">,layer:Layer)=>layer.maskAnchor?cloneLayerMask(doc,layer).key:layer.mask;

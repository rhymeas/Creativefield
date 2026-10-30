import {imageAnnotationsSchema,type ImageAnnotation} from "../annotations";
import {blankCanvas} from "./bitmaps";
import {freezeModifyMatte,type ModifyMatte} from "./ai-layer";
import type {Doc} from "./doc";

/** Restrict the new result layer to the union of the requested regions.
 * Preserve composite transparency as well as all pixels outside the boxes. */
export function annotationMatte(doc:Doc,regions:ImageAnnotation[]):ModifyMatte {
  const boxes=imageAnnotationsSchema.parse(regions);
  const matte=freezeModifyMatte({...doc,selection:null},"composite");
  const mask=blankCanvas(doc.width,doc.height),ctx=mask.getContext("2d")!;
  let x0=doc.width,y0=doc.height,x1=0,y1=0;
  for(const box of boxes){
    const x=Math.floor(box.x*doc.width),y=Math.floor(box.y*doc.height);
    const right=Math.min(doc.width,Math.ceil((box.x+box.w)*doc.width));
    const bottom=Math.min(doc.height,Math.ceil((box.y+box.h)*doc.height));
    ctx.fillRect(x,y,right-x,bottom-y);x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,right);y1=Math.max(y1,bottom);
  }
  const target=matte.canvas.getContext("2d")!;target.globalCompositeOperation="destination-in";target.drawImage(mask,0,0);
  return {canvas:matte.canvas,bounds:{x:x0,y:y0,w:x1-x0,h:y1-y0}};
}

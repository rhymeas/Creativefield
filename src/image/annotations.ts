import {z} from "zod";

export const imageAnnotationsSchema=z.array(z.object({
  x:z.number().finite().min(0).max(1),y:z.number().finite().min(0).max(1),
  w:z.number().finite().positive().max(1),h:z.number().finite().positive().max(1),
  instruction:z.string().trim().min(1).max(500),
}).strict().refine(box=>box.x+box.w<=1.000001&&box.y+box.h<=1.000001,"Keep the box inside the image")).min(1).max(8);
export type ImageAnnotation=z.infer<typeof imageAnnotationsSchema>[number];
export const annotationStorageKey=(workspace:string,asset:string)=>`comfyfield.annotations.${workspace}.${asset}`;
export function annotationInstruction(boxes:ImageAnnotation[],prompt="") {
  const valid=imageAnnotationsSchema.parse(boxes);
  return `${prompt.trim()}\nImage 1 is the clean original. Image 2 is a guide showing numbered boxes. Apply ALL numbered edits to image 1 in one result. Change only their indicated regions; keep the image size, composition and everything outside these regions unchanged. Do not include guide boxes, numbers or labels in the result. Coordinates are normalized from the top-left.\n${JSON.stringify(valid.map((box,index)=>({region:index+1,...box})))}`.trim();
}
/** The guide is a separate reference. Never paint annotations onto the source. */
export function annotationGuide(source:HTMLCanvasElement,boxes:ImageAnnotation[]) {
  const valid=imageAnnotationsSchema.parse(boxes),guide=document.createElement("canvas");
  guide.width=source.width;guide.height=source.height;const ctx=guide.getContext("2d")!;
  ctx.drawImage(source,0,0);ctx.strokeStyle="#2fa8ff";ctx.fillStyle="#2fa8ff";
  const unit=Math.max(14,Math.round(Math.min(guide.width,guide.height)/35));
  ctx.lineWidth=Math.max(2,unit/7);ctx.setLineDash([unit/2,unit/3]);ctx.font=`600 ${unit}px sans-serif`;
  valid.forEach((box,index)=>{const x=box.x*guide.width,y=box.y*guide.height;
    ctx.strokeRect(x,y,box.w*guide.width,box.h*guide.height);ctx.fillRect(x,y,unit*1.6,unit*1.5);
    ctx.fillStyle="#101214";ctx.fillText(String(index+1),x+unit*.35,y+unit*1.1);ctx.fillStyle="#2fa8ff";
  });return guide;
}

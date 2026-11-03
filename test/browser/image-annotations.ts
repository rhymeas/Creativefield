import {annotationGuide} from "../../src/image/annotations";
import {annotationMatte} from "../../src/image/editor/annotation-matte";
import {blankCanvas,setBitmap} from "../../src/image/editor/bitmaps";
import {docFromImage} from "../../src/image/editor/doc";
import {addAiResultLayer,cutoutModifiedResult} from "../../src/image/editor/ai-layer";
import {renderDoc} from "../../src/image/editor/render";

export function runAnnotationChecks(){
  const check=(ok:unknown,label:string)=>{if(!ok)throw new Error(label);};
  const source=blankCanvas(100,60),c=source.getContext("2d")!;c.fillStyle="red";c.fillRect(0,0,100,60);c.clearRect(15,15,2,2);
  const before=source.toDataURL(),regions=[{x:.1,y:.1,w:.2,h:.3,instruction:"blue"},{x:.7,y:.5,w:.2,h:.3,instruction:"green"}];
  annotationGuide(source,regions);check(source.toDataURL()===before,"guide changed the clean source");
  setBitmap("annotation-qa-source",source);const doc=docFromImage("Annotations","annotation-qa-source",100,60),matte=annotationMatte(doc,regions);
  const generated=blankCanvas(100,60);generated.getContext("2d")!.fillStyle="blue";generated.getContext("2d")!.fillRect(0,0,100,60);
  const result=cutoutModifiedResult(generated,{x:0,y:0,w:100,h:60},matte);setBitmap("annotation-qa-result",result);
  const next=addAiResultLayer(doc,"annotation-qa-result","Annotated edit",matte.bounds),out=blankCanvas(100,60);renderDoc(out.getContext("2d")!,next);
  const pixels=out.getContext("2d")!.getImageData(0,0,100,60).data,original=c.getImageData(0,0,100,60).data;
  let protectedPixels=0,changedPixels=0;
  for(let y=0;y<60;y++)for(let x=0;x<100;x++){
    const offset=(y*100+x)*4,inside=regions.some(b=>x>=Math.floor(b.x*100)&&x<Math.ceil((b.x+b.w)*100)&&y>=Math.floor(b.y*60)&&y<Math.ceil((b.y+b.h)*60));
    if(!inside){for(let i=0;i<4;i++)check(pixels[offset+i]===original[offset+i],"protected pixel drift");protectedPixels++;}
    else if(original[offset+3]){check(pixels[offset+2]===255,"region did not change");changedPixels++;}
    else check(pixels[offset+3]===0,"transparent hole filled");
  }
  check(changedPixels>0&&protectedPixels>0,"missing coverage");
  return {protectedPixels,changedPixels,guideLeavesSourceUnchanged:true,transparentHolePreserved:true,bounds:matte.bounds};
}

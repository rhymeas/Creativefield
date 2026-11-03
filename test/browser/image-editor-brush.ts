/** Bundle into a same-origin QA script and run against real Canvas2D. */
import {blankCanvas,setBitmap} from "../../src/image/editor/bitmaps";
import {docFromImage,updateLayer} from "../../src/image/editor/doc";
import {selectionInLayerSpace} from "../../src/image/editor/selection";
import {createBrushStroke,compositeBrushStroke,brushEdgeBlur,paintSuperSoftRound} from "../../src/image/editor/brush-stroke";

export function runBrushChecks(){
  const passed:string[]=[],check=(value:unknown,message:string)=>{if(!value)throw Error(message);};
  const pixel=(c:HTMLCanvasElement,x:number,y:number)=>Array.from(c.getContext("2d")!.getImageData(x,y,1,1).data);
  const target=blankCanvas(16,12),stroke=createBrushStroke(target),paint=stroke.paint.getContext("2d")!;
  paint.fillStyle="red";paint.fillRect(1,1,8,8);compositeBrushStroke(target,stroke,50,"source-over");
  const first=pixel(target,4,4);paint.fillRect(1,1,8,8);compositeBrushStroke(target,stroke,50,"source-over");
  check(first.join()===pixel(target,4,4).join()&&Math.abs(first[3]-128)<=1,"Overlapping dabs must not exceed stroke opacity.");
  passed.push("stroke opacity caps overlapping dabs");
  const second=createBrushStroke(target);second.paint.getContext("2d")!.drawImage(stroke.paint,0,0);compositeBrushStroke(target,second,50,"source-over");
  check(Math.abs(pixel(target,4,4)[3]-192)<=1,"A separate stroke must build opacity.");passed.push("separate strokes build opacity");
  const base=blankCanvas(16,12),b=base.getContext("2d")!;b.fillStyle="blue";b.fillRect(0,0,16,12);
  const selection=blankCanvas(16,12);selection.getContext("2d")!.fillRect(0,0,8,12);setBitmap("brush-selection",selection);
  const erase=createBrushStroke(base,selection);erase.paint.getContext("2d")!.fillRect(0,0,16,12);compositeBrushStroke(base,erase,50,"destination-out");
  check(Math.abs(pixel(base,2,2)[3]-127)<=1&&pixel(base,12,2).join()==="0,0,255,255","Eraser opacity must honor selection and protected pixels.");passed.push("selected eraser preserves outside RGBA");
  const locked=blankCanvas(16,12);locked.getContext("2d")!.fillRect(2,2,4,4);const lock=createBrushStroke(locked);lock.paint.getContext("2d")!.fillRect(0,0,16,12);compositeBrushStroke(locked,lock,50,"source-atop");
  check(pixel(locked,0,0)[3]===0&&pixel(locked,3,3)[3]===255,"Transparency lock must retain the alpha silhouette.");passed.push("transparency lock retains silhouette");
  let doc=docFromImage("Layer","unused",16,12);doc={...updateLayer(doc,doc.selectedId!,{rotation:180}),selection:"brush-selection"};
  const local=selectionInLayerSpace(doc,doc.layers[0])!;check(pixel(local,1,6)[3]===0&&pixel(local,14,6)[3]===255,"Selection must rotate into layer coordinates.");passed.push("rotated selection maps into layer bitmap");
  check(brushEdgeBlur(100,100)===0&&brushEdgeBlur(100,50)>0&&brushEdgeBlur(100,0)>brushEdgeBlur(100,50),"Hardness endpoints must control the edge.");passed.push("hardness controls edge softness");
  const soft=blankCanvas(101,101),softContext=soft.getContext("2d")!;paintSuperSoftRound(softContext,50,50,80,"#ffffff",0);
  const center=pixel(soft,50,50)[3],middle=pixel(soft,70,50)[3],edge=pixel(soft,88,50)[3];
  check(center>middle&&middle>edge&&edge>0&&pixel(soft,91,50)[3]===0,"Super-soft round must fade continuously to a clear true-radius edge.");passed.push("super-soft round has radial falloff");
  return passed;
}

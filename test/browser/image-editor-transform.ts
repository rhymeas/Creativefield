import {blankCanvas,setBitmap} from "../../src/image/editor/bitmaps";
import {docFromImage,updateLayer} from "../../src/image/editor/doc";
import {renderDoc} from "../../src/image/editor/render";
import {cloneLayerMask} from "../../src/image/editor/layer-mask";
import {applyMaskToLayer} from "../../src/image/editor/selection";
import {cropViewport} from "../../src/image/editor/crop-extend";

export function runTransformMaskChecks(){
  const passed:string[]=[],check=(v:unknown,m:string)=>{if(!v)throw Error(m);};
  const source=blankCanvas(64,64),s=source.getContext("2d")!;s.fillStyle="red";s.fillRect(0,0,64,64);setBitmap("transform-source",source);
  const mask=blankCanvas(64,64),m=mask.getContext("2d")!;m.fillRect(16,20,20,12);m.clearRect(22,24,4,4);setBitmap("transform-mask",mask);
  let doc=docFromImage("Masked cutout","transform-source",64,64);doc=updateLayer(doc,doc.selectedId!,{mask:"transform-mask"});const id=doc.selectedId!;
  const render=(d:typeof doc)=>{const c=blankCanvas(d.width,d.height);renderDoc(c.getContext("2d")!,d);return c;};
  const rgba=(c:HTMLCanvasElement,x:number,y:number)=>Array.from(c.getContext("2d")!.getImageData(x,y,1,1).data);
  const bytes=(c:HTMLCanvasElement)=>c.getContext("2d")!.getImageData(0,0,c.width,c.height).data;
  const same=(a:HTMLCanvasElement,b:HTMLCanvasElement)=>{const left=bytes(a),right=bytes(b);return left.length===right.length&&left.every((v,i)=>v===right[i]);};
  const moved=updateLayer(doc,id,{x:42,y:37}),out=render(moved);
  check(rgba(out,27,26).join()==="255,0,0,255"&&rgba(out,32,29)[3]===0&&rgba(out,17,21)[3]===0,"Mask must follow movement including its transparent hole.");passed.push("move keeps masked cutout and hole aligned");
  const back=updateLayer(updateLayer(moved,id,{x:500,y:-500}),id,{x:32,y:32});check(same(render(back),render(doc)),"Off-canvas round trip must retain original mask pixels.");passed.push("off-canvas round trip retains immutable mask");
  const rotated=render(updateLayer(doc,id,{rotation:90}));check(rgba(rotated,33,18)[3]===255&&rgba(rotated,36,22)[3]===0&&rgba(rotated,17,21)[3]===0,"Rotation must transform the mask with its layer.");passed.push("rotation follows mask and hole");
  const flipped=render(updateLayer(doc,id,{flipX:true}));check(rgba(flipped,46,21)[3]===255&&rgba(flipped,39,25)[3]===0&&rgba(flipped,17,21)[3]===0,"Flip must transform mask and hole.");passed.push("flip follows mask and hole");
  const clone=cloneLayerMask(moved,moved.layers[0]),baked=updateLayer(moved,id,{mask:clone.key});check(!baked.layers[0].maskAnchor&&same(render(baked),out),"Editing clone must bake effective mask and clear the old anchor.");passed.push("mask edit rebases without changing rendered pixels");
  const key=applyMaskToLayer(moved,moved.layers[0],source)!;const applied=updateLayer(moved,id,{src:key,mask:undefined});check(same(render(applied),out),"Apply mask must use transformed mask.");passed.push("apply mask matches transformed output");
  const cropped=render(cropViewport(moved,{x:10,y:4,w:50,h:60}));check(rgba(cropped,17,22).join()==="255,0,0,255"&&rgba(cropped,22,25)[3]===0,"Crop must shift effective mask once.");passed.push("crop preserves effective mask placement");
  return passed;
}

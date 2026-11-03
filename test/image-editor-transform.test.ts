import {describe,expect,it} from "vitest";
import {docFromImage,updateLayer,commit,startHistory,undo,redo} from "../src/image/editor/doc";
import {dragLayerTransform,transformCorner,applyLayerTransform} from "../src/image/editor/free-transform";
import {validateDocument} from "../src/image/editor/document-format";
const doc=docFromImage("Cutout","alpha-source",100,60),layer=doc.layers[0];
describe("proportional free transform",()=>{
  it("does not jump when the pointer grabs a screen-offset handle",()=>{
    expect(dragLayerTransform(layer,"se",{x:150,y:100},{x:150,y:100})).toBe(layer);
    expect(dragLayerTransform(layer,"move",{x:-20,y:200},{x:-10,y:205})).toMatchObject({x:layer.x+10,y:layer.y+5,src:layer.src});
  });
  it("keeps the opposite rotated corner fixed and preserves aspect ratio",()=>{
    const rotated={...layer,rotation:37},anchor=transformCorner(rotated,"nw"),handle=transformCorner(rotated,"se");
    const next=dragLayerTransform(rotated,"se",handle,{x:handle.x+(handle.x-anchor.x)*.5,y:handle.y+(handle.y-anchor.y)*.5});
    expect(next.scale).toBeCloseTo(rotated.scale*1.5);const opposite=transformCorner(next,"nw");expect(opposite.x).toBeCloseTo(anchor.x);expect(opposite.y).toBeCloseTo(anchor.y);
  });
  it("scales about the center with Alt and prevents inversion/invalid geometry",()=>{
    const handle=transformCorner(layer,"se"),next=dragLayerTransform(layer,"se",handle,{x:handle.x+30,y:handle.y+18},{center:true});
    expect(next.x).toBe(layer.x);expect(next.y).toBe(layer.y);expect(next.scale).toBeCloseTo(layer.scale*1.6);
    expect(dragLayerTransform(layer,"se",handle,{x:-10000,y:-10000}).scale).toBe(.01);
    expect(applyLayerTransform(doc,layer.id,{...layer,scale:NaN})).toBe(doc);
  });
  it("snaps rotation, respects position locks and retains source pixels/one Undo transaction",()=>{
    const next=dragLayerTransform(layer,"rotate",{x:layer.x+10,y:layer.y},{x:layer.x+10,y:layer.y+8},{snap:true});expect(next.rotation%15).toBe(0);
    const locked={...layer,locks:{position:true}};expect(dragLayerTransform(locked,"move",{x:0,y:0},{x:20,y:10})).toBe(locked);
    const edited=applyLayerTransform(doc,layer.id,next),history=commit(startHistory(doc),edited);expect(edited.layers[0].src).toBe(layer.src);expect(undo(history).present).toBe(doc);expect(redo(undo(history)).present).toBe(edited);
    const lockedDoc=updateLayer(doc,layer.id,{locks:{position:true}});expect(applyLayerTransform(lockedDoc,layer.id,next)).toBe(lockedDoc);
  });
  it("persists the original mask anchor and clears it when mask pixels are replaced",()=>{
    const ref="asset:11111111-1111-4111-8111-111111111111",masked=updateLayer(updateLayer(doc,layer.id,{src:ref,mask:ref}),layer.id,{x:70,rotation:45});
    expect(masked.layers[0].maskAnchor).toEqual({x:layer.x,y:layer.y,scale:layer.scale,rotation:layer.rotation,flipX:layer.flipX});
    expect(validateDocument(masked).layers[0].maskAnchor).toEqual(masked.layers[0].maskAnchor);
    expect(updateLayer(masked,layer.id,{mask:"new"}).layers[0].maskAnchor).toBeUndefined();
  });
});

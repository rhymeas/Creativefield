import {describe,it,expect} from "vitest";
import {hitObject,imageSignature} from "../src/image/editor/region-tools";
import {hasExposedBorder,normalizeViewport,scaleViewport} from "../src/image/editor/crop-extend";
import {resizeCrop,fullCrop} from "../src/image/editor/crop";
import {docFromImage,updateLayer} from "../src/image/editor/doc";

describe("editor regions",()=>{
  it("keeps exact pixels for ordinary crops; model alignment applies only to generated borders",()=>{
    expect(normalizeViewport({x:0,y:0,w:575,h:431},false)).toEqual({x:0,y:0,w:575,h:431});
    expect(normalizeViewport({x:0,y:0,w:575,h:431})).toEqual({x:0,y:0,w:568,h:424});
    expect(normalizeViewport({x:0,y:0,w:1,h:1},false).w).toBe(1);
  });
  it("allows outward crop handles only with extension enabled and bounds the generated dimensions",()=>{
    const bounds={w:640,h:480},r=fullCrop(bounds);
    expect(resizeCrop(r,"nw",{x:-64,y:-64},bounds)).toEqual(r);
    expect(resizeCrop(r,"nw",{x:-64,y:-64},bounds,8,true)).toEqual({x:-64,y:-64,w:704,h:544});
    expect(resizeCrop(r,"se",{x:9000,y:9000},bounds,8,true)).toEqual({x:0,y:0,w:2048,h:2048});
    expect(normalizeViewport({x:-63.6,y:-63.6,w:769,h:609})).toEqual({x:-64,y:-64,w:768,h:608});
    expect(()=>normalizeViewport({x:0,y:0,w:2049,h:8})).not.toThrow();
    expect(()=>normalizeViewport({x:0,y:0,w:2056,h:8})).toThrow(/2048/);
    expect(hasExposedBorder({x:-64,y:0,w:704,h:480},640,480)).toBe(true);
    expect(hasExposedBorder({x:0,y:0,w:320,h:240},640,480)).toBe(false);
  });
  it("scales the applied crop resolution and layer geometry together",()=>{
    const source=docFromImage("Source","pixels",640,480),scaled=scaleViewport(source,50);
    expect([scaled.width,scaled.height]).toEqual([320,240]);
    expect(scaled.layers[0]).toMatchObject({x:160,y:120,w:320,h:240});
    expect(()=>scaleViewport(source,0)).toThrow(/10% and 800%/);
    expect(()=>scaleViewport(source,400)).toThrow(/2048 px per side/);
  });
  it("chooses the smallest overlapping object and rejects outside-canvas hover",()=>{
    const a=new Uint8ClampedArray(16),b=new Uint8ClampedArray(16);a[3]=255;b[3]=255;
    const regions=[{alpha:a,area:20},{alpha:b,area:3}];
    expect(hitObject(regions,.2,.2,2,2)).toBe(1);
    expect(hitObject(regions,1,1,2,2)).toBe(-1);
    expect(hitObject(regions,-.1,0,2,2)).toBe(-1);
    expect(hitObject(regions,2,0,2,2)).toBe(-1);
  });
  it("invalidates cached objects for rendered edits but not selection changes",()=>{
    const doc=docFromImage("Source","pixels",640,480),signature=imageSignature(doc);
    expect(imageSignature({...doc,selectedId:null,selection:"mask"})).toBe(signature);
    expect(imageSignature(updateLayer(doc,doc.selectedId!,{x:200}))).not.toBe(signature);
    expect(imageSignature({...doc,width:648})).not.toBe(signature);
  });
});

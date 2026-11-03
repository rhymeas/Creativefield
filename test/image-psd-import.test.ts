import {afterEach, describe, expect, it, vi} from "vitest";
import {initializeCanvas, readPsd, writePsdBuffer, type Psd} from "ag-psd";
import {documentFromPsd, placePsd} from "../src/image/editor/import-psd";
import {emptyDoc} from "../src/image/editor/doc";
import {getBitmap} from "../src/image/editor/bitmaps";

function pixels(r: number) {
  return {width: 2, height: 2, data: new Uint8ClampedArray([r,0,0,255, r,0,0,255, r,0,0,255, r,0,0,255])};
}
function canvasStub() {
  initializeCanvas(() => ({} as HTMLCanvasElement), (w, h) => ({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}) as ImageData);
  vi.stubGlobal("document", {createElement: () => {
    const canvas = {width: 0, height: 0, pixels: new Uint8ClampedArray(), getContext: () => ({
      createImageData: (w: number, h: number) => ({data: new Uint8ClampedArray(w*h*4)}),
      putImageData: (image: {data: Uint8ClampedArray}) => {canvas.pixels = image.data;},
      fillRect: () => {}, drawImage: () => {},
    })};
    return canvas;
  }});
}
afterEach(() => vi.unstubAllGlobals());

describe("PSD import", () => {
  it("keeps the saved composite hidden as a reference when effects cannot be imported", () => {
    canvasStub();
    const {doc,warnings} = documentFromPsd({width:2,height:2,imageData:pixels(200),children:[{name:"Editable",imageData:pixels(20),effects:{} as never}]});
    expect(doc.layers.map(layer => [layer.name,layer.visible])).toEqual([["Editable",true],["Photoshop composite (reference)",false]]);
    expect(doc.selectedId).toBe(doc.layers[0].id);
    expect((getBitmap(doc.layers[1].src) as unknown as {pixels:Uint8ClampedArray}).pixels[0]).toBe(200);
    expect(warnings).toContain("Layer effects are not imported.");
    expect(warnings).toContain("The hidden Photoshop composite layer shows the saved appearance.");
  });
  it("opens actual PSD bytes with layered order, positions, visibility, opacity and groups", () => {
    canvasStub();
    const original: Psd = {width: 20, height: 10, children: [
      {name: "Bottom", hidden: true, imageData: pixels(20)},
      {name: "Group", children: [{name: "Top", left: 3, top: 2, opacity: .5, imageData: pixels(255)}]},
    ]};
    const parsed = readPsd(writePsdBuffer(original), {useImageData: true, skipThumbnail: true});
    const {doc, warnings} = documentFromPsd(parsed);
    expect(doc.layers.map(layer => layer.name)).toEqual(["Bottom", "Top"]);
    expect(doc.layers[0].visible).toBe(false);
    expect(doc.layers[1]).toMatchObject({x: 4, y: 3, w: 2, h: 2, opacity: expect.closeTo(.5, 2)});
    expect(doc.groups?.[doc.layers[1].group!].name).toBe("Group");
    expect(warnings).toEqual([]);
  });

  it("warns about unsupported masks and preserves the existing canvas when placing layers", () => {
    canvasStub();
    const source: Psd = {width: 20, height: 10, children: [{name:"Masked", imageData:pixels(10), mask:{}}]};
    const result = documentFromPsd(source);
    expect(result.warnings).toContain("Some layer masks could not be imported.");
    const current = emptyDoc(10, 10);
    const placed = placePsd(current, result.doc);
    expect(placed).toMatchObject({width:10, height:10});
    expect(placed.layers[0]).toMatchObject({x:.5, y:3, scale:.5});
    expect(current.layers).toEqual([]);
  });

  it("rejects oversized documents rather than exhausting canvas memory", () => {
    expect(() => documentFromPsd({width:10000,height:10000})).toThrow(/16-megapixel/);
  });

  it("converts high bit-depth pixel data instead of clipping it", () => {
    canvasStub();
    const {doc,warnings} = documentFromPsd({width:1,height:1,bitsPerChannel:16,children:[{imageData:{width:1,height:1,data:new Uint16Array([32768,0,65535,65535])}}]});
    const canvas = getBitmap(doc.layers[0].src) as unknown as {pixels: Uint8ClampedArray};
    expect([...canvas.pixels]).toEqual([128,0,255,255]);
    expect(warnings).toContain("High bit-depth pixels were converted to 8-bit.");
  });

  it("imports a bitmap mask as editable alpha, and retains it when placed", () => {
    canvasStub();
    const maskPixels = {width:2,height:1,data:new Uint8ClampedArray([0,0,0,255,255,255,255,255])};
    const original: Psd = {width: 8, height: 8, children: [{name:"Masked", imageData:pixels(255), mask:{left:1,top:2,defaultColor:255,imageData:maskPixels}}]};
    const parsed = readPsd(writePsdBuffer(original), {useImageData:true, skipThumbnail:true});
    const result = documentFromPsd(parsed);
    const mask = getBitmap(result.doc.layers[0].mask!) as unknown as {pixels: Uint8ClampedArray};
    expect([mask.pixels[3],mask.pixels[7]]).toEqual([0,255]);
    expect(result.warnings).toEqual([]);
    const placed = placePsd(emptyDoc(4,4), result.doc);
    expect(placed.layers[0].mask).toBeTruthy();
    expect(placed.layers[0].mask).not.toBe(result.doc.layers[0].mask);
  });

  it("retains clipping when reading actual PSD layer data", () => {
    canvasStub();
    const original: Psd = {width:8,height:8,children:[
      {name:"Base",imageData:pixels(20)},
      {name:"Clipped",clipping:true,imageData:pixels(255)},
    ]};
    const result = documentFromPsd(readPsd(writePsdBuffer(original), {useImageData:true,skipThumbnail:true}));
    expect(result.doc.layers.map(layer => [layer.name,layer.clip])).toEqual([["Base",false],["Clipped",true]]);
    expect(result.warnings.some(warning => warning.includes("Clipping"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {CropHandles} from "../src/ds/CropHandles";
import { cropHandleAt, dragCrop, fullCrop, isFullCrop, resizeCrop } from "../src/image/editor/crop";

const bounds = { w: 1000, h: 800 };

describe("crop handles", () => {
  it("does not jump when an offset handle is grabbed and drags from the original box",()=>{
    const box=fullCrop(bounds),grab={x:1016,y:816};
    expect(dragCrop(box,"se",grab,grab,bounds,true)).toEqual(box);
    expect(dragCrop(box,"se",grab,{x:916,y:716},bounds)).toEqual({x:0,y:0,w:900,h:700});
    expect(dragCrop(box,"nw",{x:-16,y:-16},{x:-48,y:-48},bounds,true)).toEqual({x:-32,y:-32,w:1032,h:832});
  });
  it("resizes vertically from the offset top and bottom edge handles",()=>{
    const box=fullCrop(bounds);
    expect(dragCrop(box,"n",{x:500,y:-12},{x:500,y:88},bounds,true)).toEqual({x:0,y:100,w:1000,h:700});
    expect(dragCrop(box,"s",{x:500,y:812},{x:500,y:612},bounds,true)).toEqual({x:0,y:0,w:1000,h:600});
  });

  it("renders one offset frame and accessible controls on every edge and corner",()=>{
    const noop=()=>{};
    const html=renderToStaticMarkup(createElement(CropHandles,{box:fullCrop(bounds),viewport:{x:40,y:30,w:500,h:400},width:bounds.w,height:bounds.h,onStart:noop,onMove:noop,onEnd:noop,onCancel:noop,onNudge:noop}));
    expect(html.match(/class="ds-crophandle"/g)).toHaveLength(8);
    expect(html).toContain('class="ds-cropframe"');
    for(const edge of ["top edge","right edge","bottom edge","left edge"])expect(html).toContain(`aria-label="Resize crop from ${edge}"`);
  });
  it("starts as the whole image", () => {
    expect(fullCrop(bounds)).toEqual({ x: 0, y: 0, w: 1000, h: 800 });
    expect(isFullCrop(fullCrop(bounds), bounds)).toBe(true);
  });

  it("finds the handle under the pointer, corners before edges", () => {
    const box = { x: 100, y: 100, w: 800, h: 600 };
    expect(cropHandleAt(box, { x: 102, y: 98 }, 12)).toBe("nw");
    expect(cropHandleAt(box, { x: 500, y: 103 }, 12)).toBe("n");
    expect(cropHandleAt(box, { x: 905, y: 400 }, 12)).toBe("e");
    expect(cropHandleAt(box, { x: 500, y: 400 }, 12)).toBeNull();
  });

  it("drags one edge and leaves the others alone", () => {
    const box = { x: 100, y: 100, w: 800, h: 600 };
    expect(resizeCrop(box, "e", { x: 600, y: 0 }, bounds)).toEqual({ x: 100, y: 100, w: 500, h: 600 });
    expect(resizeCrop(box, "nw", { x: 150, y: 120 }, bounds)).toEqual({ x: 150, y: 120, w: 750, h: 580 });
  });

  it("stays inside the image and keeps a minimum size", () => {
    const box = { x: 100, y: 100, w: 800, h: 600 };
    expect(resizeCrop(box, "se", { x: 5000, y: 5000 }, bounds)).toEqual({ x: 100, y: 100, w: 900, h: 700 });
    expect(resizeCrop(box, "w", { x: 5000, y: 0 }, bounds).w).toBe(8);
    expect(resizeCrop(box, "nw", { x: -50, y: -50 }, bounds)).toEqual({ x: 0, y: 0, w: 900, h: 700 });
  });

  it("reports a changed box as not full", () => {
    expect(isFullCrop({ x: 0, y: 0, w: 999, h: 800 }, bounds)).toBe(false);
  });
});

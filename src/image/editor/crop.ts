/* Crop box geometry: where the handles are, which one the pointer hits, and how a drag reshapes the box.
   Pure functions, so the pointer wiring in ImageEditor stays thin and the rules are tested on their own. */

export type CropRect = { x: number; y: number; w: number; h: number };
export type CropHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type Point = { x: number; y: number };

export const CROP_HANDLES: CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** The whole image as a crop box. */
export function fullCrop(bounds: { w: number; h: number }): CropRect {
  return { x: 0, y: 0, w: bounds.w, h: bounds.h };
}

/** Where each handle sits: four corners and four edge midpoints. */
export function cropHandlePoints(r: CropRect): Array<{ handle: CropHandle; x: number; y: number }> {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const right = r.x + r.w;
  const bottom = r.y + r.h;
  return [
    { handle: "nw", x: r.x, y: r.y },
    { handle: "n", x: cx, y: r.y },
    { handle: "ne", x: right, y: r.y },
    { handle: "e", x: right, y: cy },
    { handle: "se", x: right, y: bottom },
    { handle: "s", x: cx, y: bottom },
    { handle: "sw", x: r.x, y: bottom },
    { handle: "w", x: r.x, y: cy },
  ];
}

/** The handle under the pointer, or null. `tol` is in image pixels; the nearest handle wins. */
export function cropHandleAt(r: CropRect, p: Point, tol: number): CropHandle | null {
  let best: CropHandle | null = null;
  let bestDistance = Infinity;
  for (const hp of cropHandlePoints(r)) {
    const distance = Math.max(Math.abs(p.x - hp.x), Math.abs(p.y - hp.y));
    if (distance <= tol && distance < bestDistance) {
      best = hp.handle;
      bestDistance = distance;
    }
  }
  return best;
}

/** Move the edges that the handle controls to the pointer. Edges stay inside the image and keep at least `min` pixels. */
export function resizeCrop(r: CropRect, handle: CropHandle, p: Point, bounds: { w: number; h: number }, min = 8, extend=false): CropRect {
  let x1 = r.x;
  let y1 = r.y;
  let x2 = r.x + r.w;
  let y2 = r.y + r.h;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  if (handle.includes("w")) x1 = clamp(p.x, extend?x2-2048:0, x2 - min);
  if (handle.includes("e")) x2 = clamp(p.x, x1 + min, extend?x1+2048:bounds.w);
  if (handle.includes("n")) y1 = clamp(p.y, extend?y2-2048:0, y2 - min);
  if (handle.includes("s")) y2 = clamp(p.y, y1 + min, extend?y1+2048:bounds.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Drag by pointer displacement, so an offset handle or off-centre grab never jumps. */
export function dragCrop(r:CropRect,handle:CropHandle,start:Point,p:Point,bounds:{w:number;h:number},extend=false):CropRect{
  const anchor=cropHandlePoints(r).find(h=>h.handle===handle)!;
  return resizeCrop(r,handle,{x:anchor.x+p.x-start.x,y:anchor.y+p.y-start.y},bounds,8,extend);
}

/** True when the box still covers the whole image, so there is nothing to crop. */
export function isFullCrop(r: CropRect, bounds: { w: number; h: number }): boolean {
  return r.x === 0 && r.y === 0 && r.w === bounds.w && r.h === bounds.h;
}

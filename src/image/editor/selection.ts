import {effectiveLayerMask} from "./layer-mask";
/* Selections: a doc-sized mask canvas (alpha = selected) kept in the bitmap registry. Every change makes a new key,
   so undo simply points the document back at the old mask. */
import { newId, type Doc, type Layer } from "./doc";
import { blankCanvas, getBitmap, setBitmap, type Bitmap } from "./bitmaps";
import { renderDoc } from "./render";
import {contractEraseAlpha} from "./matting";

export type SelectMode = "replace" | "add" | "subtract" | "intersect";

function register(canvas: HTMLCanvasElement): string {
  const key = newId("sel:");
  setBitmap(key, canvas);
  return key;
}

/** Combine a new shape (white where selected) with the current selection. */
export function combine(doc: Doc, shape: HTMLCanvasElement, mode: SelectMode): string {
  const out = blankCanvas(doc.width, doc.height);
  const ctx = out.getContext("2d")!;
  const prev = doc.selection ? getBitmap(doc.selection) : undefined;
  if (mode === "intersect") {
    if (prev) {
      ctx.drawImage(prev, 0, 0);
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(shape, 0, 0);
    }
    return register(out);
  }
  if (mode !== "replace" && prev) ctx.drawImage(prev, 0, 0);
  ctx.globalCompositeOperation = mode === "subtract" ? "destination-out" : "source-over";
  ctx.drawImage(shape, 0, 0);
  return register(out);
}

/** Corners of a marquee drag. Shift makes it square, Alt grows it from the first point (as in Photoshop). */
export function marqueeRect(a: { x: number; y: number }, b: { x: number; y: number }, square: boolean, fromCenter: boolean) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (square) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * m;
    dy = Math.sign(dy || 1) * m;
  }
  const x0 = fromCenter ? a.x - dx : a.x;
  const y0 = fromCenter ? a.y - dy : a.y;
  return { x: Math.min(x0, a.x + dx), y: Math.min(y0, a.y + dy), w: Math.abs(a.x + dx - x0), h: Math.abs(a.y + dy - y0) };
}

export function rectShape(doc: Doc, rect: { x: number; y: number; w: number; h: number }): HTMLCanvasElement {
  const c = blankCanvas(doc.width, doc.height);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  return c;
}

export function allShape(doc: Doc): HTMLCanvasElement {
  const c = blankCanvas(doc.width, doc.height);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, doc.width, doc.height);
  return c;
}

export function lassoShape(doc: Doc, points: Array<{ x: number; y: number }>): HTMLCanvasElement {
  const c = blankCanvas(doc.width, doc.height);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fill();
  return c;
}

/** Magic wand: contiguous pixels of the visible picture close in color to the clicked one. */
export function wandShape(doc: Doc, at: { x: number; y: number }, tolerance: number, options: { contiguous?: boolean; onlyLayer?: string | null } = {}): HTMLCanvasElement {
  const { contiguous = true, onlyLayer = null } = options;
  const flat = blankCanvas(doc.width, doc.height);
  const source = onlyLayer ? { ...doc, layers: doc.layers.filter((l) => l.id === onlyLayer).map((l) => ({ ...l, visible: true })) } : doc;
  renderDoc(flat.getContext("2d")!, source);
  const { width: w, height: h } = flat;
  const data = flat.getContext("2d")!.getImageData(0, 0, w, h).data;
  const x0 = Math.min(w - 1, Math.max(0, Math.floor(at.x)));
  const y0 = Math.min(h - 1, Math.max(0, Math.floor(at.y)));
  const o = (y0 * w + x0) * 4;
  const [r, g, b, a] = [data[o], data[o + 1], data[o + 2], data[o + 3]];
  const limit = tolerance * tolerance * 4;
  if (!contiguous) {
    const all = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      if ((data[p] - r) ** 2 + (data[p + 1] - g) ** 2 + (data[p + 2] - b) ** 2 + (data[p + 3] - a) ** 2 <= limit) all[p] = all[p + 1] = all[p + 2] = all[p + 3] = 255;
    }
    const every = blankCanvas(w, h);
    every.getContext("2d")!.putImageData(new ImageData(all, w, h), 0, 0);
    return every;
  }
  const seen = new Uint8Array(w * h);
  const out = new Uint8ClampedArray(w * h * 4);
  const stack = new Int32Array(w * h);
  let top = 0;
  stack[top++] = y0 * w + x0;
  seen[y0 * w + x0] = 1;
  while (top > 0) {
    const i = stack[--top];
    const p = i * 4;
    const d = (data[p] - r) ** 2 + (data[p + 1] - g) ** 2 + (data[p + 2] - b) ** 2 + (data[p + 3] - a) ** 2;
    if (d > limit) continue;
    out[p] = out[p + 1] = out[p + 2] = out[p + 3] = 255;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0 && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
    if (x < w - 1 && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
    if (y > 0 && !seen[i - w]) { seen[i - w] = 1; stack[top++] = i - w; }
    if (y < h - 1 && !seen[i + w]) { seen[i + w] = 1; stack[top++] = i + w; }
  }
  const shape = blankCanvas(w, h);
  shape.getContext("2d")!.putImageData(new ImageData(out, w, h), 0, 0);
  return shape;
}

export function invertSelection(doc: Doc): string {
  const out = blankCanvas(doc.width, doc.height);
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, doc.width, doc.height);
  const prev = doc.selection ? getBitmap(doc.selection) : undefined;
  if (prev) {
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(prev, 0, 0);
  }
  return register(out);
}

/** The selection as an opaque-white-on-clear bitmap of its own: becomes a mask layer. */
export function maskBitmap(doc: Doc): string | null {
  const prev = doc.selection ? getBitmap(doc.selection) : undefined;
  if (!prev) return null;
  const out = blankCanvas(doc.width, doc.height);
  out.getContext("2d")!.drawImage(prev, 0, 0);
  return register(out);
}

/** Erase a previewed region nondestructively, including on smart objects. */
export function eraseRegionMask(doc:Doc,layer:Layer):string|null{
  const selection=doc.selection?getBitmap(doc.selection):undefined;if(!selection)return null;
  const existing=layer.mask&&!layer.maskOff?effectiveLayerMask(doc,layer):undefined;
  if(layer.mask&&!layer.maskOff&&!existing)return null;
  const canvas=blankCanvas(doc.width,doc.height),ctx=canvas.getContext("2d")!;
  if(existing)ctx.drawImage(existing,0,0);else{ctx.fillStyle="#fff";ctx.fillRect(0,0,doc.width,doc.height);}
  const erase=blankCanvas(doc.width,doc.height),ec=erase.getContext("2d")!;ec.drawImage(selection,0,0);
  const pixels=ec.getImageData(0,0,doc.width,doc.height),alpha=new Uint8ClampedArray(doc.width*doc.height);
  for(let i=0;i<alpha.length;i++)alpha[i]=255-pixels.data[i*4+3];
  const soft=contractEraseAlpha(alpha,doc.width,doc.height,1);
  for(let i=0;i<soft.length;i++)pixels.data[i*4+3]=255-soft[i];
  ec.putImageData(pixels,0,0);
  ctx.globalCompositeOperation="destination-out";ctx.drawImage(erase,0,0);
  return register(canvas);
}

/** Put the selection into a layer's own pixel space (inverse of how the layer is drawn). */
function inLayerSpace(ctx: CanvasRenderingContext2D, layer: Layer) {
  ctx.translate(layer.w / 2, layer.h / 2);
  ctx.scale((layer.flipX ? -1 : 1) / layer.scale, 1 / layer.scale);
  ctx.rotate((-layer.rotation * Math.PI) / 180);
  ctx.translate(-layer.x, -layer.y);
}

/** Freeze the current selection in the bitmap coordinates used by a paint stroke. */
export function selectionInLayerSpace(doc:Doc,layer:Layer):HTMLCanvasElement|null{
  const mask=doc.selection?getBitmap(doc.selection):undefined;if(!mask)return null;
  const canvas=blankCanvas(layer.w,layer.h),ctx=canvas.getContext("2d")!;inLayerSpace(ctx,layer);ctx.drawImage(mask,0,0);return canvas;
}

/** New bitmap for a layer with the selected pixels erased or filled. Returns the registry key and canvas. */
export function editSelected(doc: Doc, layer: Layer, action: { kind: "delete" } | { kind: "fill"; color: string }, source: Bitmap): { key: string; canvas: HTMLCanvasElement } | null {
  const mask = doc.selection ? getBitmap(doc.selection) : undefined;
  if (!mask) return null;
  const canvas = blankCanvas(layer.w, layer.h);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0, layer.w, layer.h);
  ctx.save();
  inLayerSpace(ctx, layer);
  if (action.kind === "delete") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(mask, 0, 0);
  } else {
    const tint = blankCanvas(doc.width, doc.height);
    const t = tint.getContext("2d")!;
    t.drawImage(mask, 0, 0);
    t.globalCompositeOperation = "source-in";
    t.fillStyle = action.color;
    t.fillRect(0, 0, doc.width, doc.height);
    ctx.drawImage(tint, 0, 0);
  }
  ctx.restore();
  return { key: register(canvas), canvas };
}

/** The selection tinted for display on the stage (never part of an export). */
export function tinted(key: string, color: string): HTMLCanvasElement | null {
  const mask = getBitmap(key);
  if (!mask) return null;
  const w = mask instanceof HTMLImageElement ? mask.naturalWidth : mask.width;
  const h = mask instanceof HTMLImageElement ? mask.naturalHeight : mask.height;
  const out = blankCanvas(w, h);
  const ctx = out.getContext("2d")!;
  ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return out;
}

/** Move the second corner so the drag keeps a width:height ratio (the larger side follows the pointer). */
export function ratioPoint(a: { x: number; y: number }, b: { x: number; y: number }, ratio: number): { x: number; y: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const w = Math.abs(dx);
  const h = Math.abs(dy);
  let nw = w;
  let nh = h;
  if (w / Math.max(h, 1e-6) > ratio) nw = h * ratio;
  else nh = w / ratio;
  return { x: a.x + Math.sign(dx || 1) * nw, y: a.y + Math.sign(dy || 1) * nh };
}

/** Bounding box of the selected pixels in document coordinates, or null when nothing is selected. */
export function selectionBounds(key: string): { x: number; y: number; w: number; h: number } | null {
  const mask = getBitmap(key);
  if (!mask) return null;
  const w = mask instanceof HTMLImageElement ? mask.naturalWidth : mask.width;
  const h = mask instanceof HTMLImageElement ? mask.naturalHeight : mask.height;
  const c = blankCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(mask, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The selection with a soft edge, for pasting an AI result back without a hard seam. */
export function featheredMask(doc: Doc, key: string, radius: number,insideOnly=false): HTMLCanvasElement | null {
  const mask = getBitmap(key);
  if (!mask) return null;
  const out = blankCanvas(doc.width, doc.height);
  const ctx = out.getContext("2d")!;
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(mask, 0, 0);
  if(insideOnly){ctx.filter="none";ctx.globalCompositeOperation="destination-in";ctx.drawImage(mask,0,0);}
  return out;
}

/** Bake a layer's mask into its own pixels (Photoshop: Apply Layer Mask). Returns the new bitmap key. */
export function applyMaskToLayer(doc: Doc, layer: Layer, source: Bitmap): string | null {
  const mask = layer.mask ? effectiveLayerMask(doc,layer) : undefined;
  if (!mask) return null;
  const canvas = blankCanvas(layer.w, layer.h);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0, layer.w, layer.h);
  ctx.save();
  inLayerSpace(ctx, layer);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask, 0, 0);
  ctx.restore();
  return register(canvas);
}

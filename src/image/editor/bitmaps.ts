/* Bitmap registry: layer pixels by key. Loaded images are keyed by URL; edited ones by `bmp:<id>` canvases. */
import { newId } from "./doc";

export type Bitmap = HTMLCanvasElement | HTMLImageElement;
const registry = new Map<string, Bitmap>();

export const getBitmap = (key: string) => registry.get(key);
export const setBitmap = (key: string, bitmap: Bitmap) => void registry.set(key, bitmap);

export function loadBitmap(src: string): Promise<{ bitmap: Bitmap; w: number; h: number }> {
  const existing = registry.get(src);
  if (existing) return Promise.resolve({ bitmap: existing, w: sizeOf(existing).w, h: sizeOf(existing).h });
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      registry.set(src, image);
      resolve({ bitmap: image, w: image.naturalWidth, h: image.naturalHeight });
    };
    image.onerror = () => reject(new Error("The image could not be loaded."));
    image.src = src;
  });
}

export const sizeOf = (bitmap: Bitmap) => (bitmap instanceof HTMLImageElement ? { w: bitmap.naturalWidth, h: bitmap.naturalHeight } : { w: bitmap.width, h: bitmap.height });

export function blankCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

/** A new editable copy of a bitmap under a fresh key. The old key stays valid for undo. */
export function cloneBitmap(key: string, w: number, h: number): { key: string; canvas: HTMLCanvasElement } {
  const canvas = blankCanvas(w, h);
  const source = registry.get(key);
  if (source) canvas.getContext("2d")!.drawImage(source, 0, 0, w, h);
  const next = newId("bmp:");
  registry.set(next, canvas);
  return { key: next, canvas };
}

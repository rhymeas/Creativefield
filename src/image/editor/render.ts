import { BLEND_OPERATION, filterOf, isVisible, groupAncestors, isGroupDescendant, type Doc, type Layer } from "./doc";
import { blankCanvas, getBitmap } from "./bitmaps";
import {defringeOnePixel} from "./matting";
import {effectiveLayerMask} from "./layer-mask";

export type Channels = { r: boolean; g: boolean; b: boolean; a: boolean };

/** Draw the whole document, bottom layer first. Missing bitmaps (still loading) are skipped. */
export function renderDoc(ctx: CanvasRenderingContext2D, doc: Doc, options: { background?: boolean;backdrop?:HTMLCanvasElement;clipContext?:Doc } = {}) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, doc.width, doc.height);
  if (options.background) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, doc.width, doc.height);
  }
  if(options.backdrop)ctx.drawImage(options.backdrop,0,0);
  const clipDoc=options.clipContext??doc;
  doc.layers.forEach((layer, index) => {
    const chain=groupAncestors(doc,layer.group).reverse();
    const groupId=chain.find(gid=>{const group=doc.groups?.[gid];return !!group&&((group.opacity??1)!==1||(group.blend??"pass-through")!=="pass-through");});
    const group=groupId?doc.groups?.[groupId]:undefined;
    if(groupId&&group){
      const last=doc.layers.reduce((found,l,i)=>isGroupDescendant(doc,groupId,l.group)?i:found,-1);
      if(index!==last||!groupAncestors(doc,groupId).every(id=>doc.groups?.[id]?.visible!==false)||(group.opacity??1)===0)return;
      const descendants=doc.layers.filter(l=>isGroupDescendant(doc,groupId,l.group));
      const childGroups=Object.fromEntries(Object.entries(doc.groups??{}).filter(([id])=>id!==groupId&&isGroupDescendant(doc,groupId,doc.groups?.[id]?.parent)).map(([id,g])=>[id,{...g,parent:g.parent===groupId?undefined:g.parent}]));
      const children={...doc,layers:descendants.map(l=>l.group===groupId?{...l,group:undefined}:l),groups:childGroups};
      const result=blankCanvas(doc.width,doc.height),opacity=group.opacity??1;
      if((group.blend??"pass-through")==="pass-through"){
        const before=blankCanvas(doc.width,doc.height);before.getContext("2d")!.drawImage(ctx.canvas,0,0);
        renderDoc(result.getContext("2d")!,children,{backdrop:before,clipContext:clipDoc});
        ctx.save();ctx.globalCompositeOperation="copy";ctx.globalAlpha=1-opacity;ctx.drawImage(before,0,0);
        ctx.globalCompositeOperation="lighter";ctx.globalAlpha=opacity;ctx.drawImage(result,0,0);ctx.restore();
      }else{
        renderDoc(result.getContext("2d")!,children,{clipContext:clipDoc});
        ctx.save();ctx.globalAlpha=opacity;ctx.globalCompositeOperation=BLEND_OPERATION[group.blend! as keyof typeof BLEND_OPERATION];ctx.drawImage(result,0,0);ctx.restore();
      }
      return;
    }
    if (!isVisible(doc, layer)) return;
    if (layer.kind === "adjust") {
      if (layer.clip) {
        /* Clipped: only the layer directly below gets the adjustment. */
        const below = clipBase(clipDoc,clipDoc.layers.findIndex(l=>l.id===layer.id));
        const pixels = below && layerCanvas(clipDoc, below);
        if (!pixels) return;
        const adjusted = blankCanvas(doc.width, doc.height);
        const a = adjusted.getContext("2d")!;
        a.filter = filterOf(layer);
        a.drawImage(pixels, 0, 0);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = layer.opacity * below.opacity;
        ctx.drawImage(adjusted, 0, 0);
        ctx.restore();
        return;
      }
      /* An adjustment layer re-renders everything below it through its filter. */
      const under = blankCanvas(doc.width, doc.height);
      under.getContext("2d")!.drawImage(ctx.canvas, 0, 0);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, doc.width, doc.height);
      ctx.drawImage(under, 0, 0);
      ctx.globalAlpha = layer.opacity;
      ctx.filter = filterOf(layer);
      ctx.drawImage(under, 0, 0);
      ctx.restore();
      return;
    }
    if (layer.clip) {
      /* Clipping mask: the layer shows only where the base layer below has pixels. */
      const base = clipBase(clipDoc,clipDoc.layers.findIndex(l=>l.id===layer.id));
      const pixels = layerCanvas(doc, layer);
      const shape = base && layerCanvas(clipDoc, base);
      if (!pixels || !shape) return;
      const pc = pixels.getContext("2d")!;
      pc.globalCompositeOperation = "destination-in";
      pc.drawImage(shape, 0, 0);
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = BLEND_OPERATION[layer.blend];
      ctx.drawImage(pixels, 0, 0);
      ctx.restore();
      return;
    }
    if (layer.mask && !layer.maskOff) {
      const pixels = layerCanvas(doc, layer);
      if (!pixels) return;
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = BLEND_OPERATION[layer.blend];
      ctx.drawImage(pixels, 0, 0);
      ctx.restore();
      return;
    }
    const bitmap = getBitmap(layer.src);
    if (!bitmap) return;
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = BLEND_OPERATION[layer.blend];
    drawPixels(ctx, layer, bitmap);
    ctx.restore();
  });
  ctx.restore();
}

/** The layer a clipped layer clips to: the nearest visible pixel layer below that is not clipped itself. */
function clipBase(doc: Doc, index: number): Layer | undefined {
  return doc.layers.slice(0, index).reverse().find((l) => l.kind !== "adjust" && !l.clip && isVisible(doc, l));
}

/** Draw one layer's pixels with its transform, tone filter and shadow (not opacity or blend). */
function drawPixels(ctx: CanvasRenderingContext2D, layer: Layer, bitmap: CanvasImageSource) {
  ctx.save();
  ctx.filter = filterOf(layer);
  if (layer.shadow) {
    /* Shadow offsets are in document pixels, so they stay put when the layer is scaled or rotated. */
    ctx.shadowColor = layer.shadow.color;
    ctx.shadowBlur = layer.shadow.blur;
    ctx.shadowOffsetX = layer.shadow.dx;
    ctx.shadowOffsetY = layer.shadow.dy;
  }
  ctx.translate(layer.x, layer.y);
  ctx.rotate((layer.rotation * Math.PI) / 180);
  ctx.scale(layer.flipX ? -layer.scale : layer.scale, layer.scale);
  ctx.drawImage(bitmap, -layer.w / 2, -layer.h / 2, layer.w, layer.h);
  ctx.restore();
}

/** One layer alone on a document-sized canvas, with its mask applied. */
export function layerCanvas(doc: Doc, layer: Layer): HTMLCanvasElement | null {
  const bitmap = getBitmap(layer.src);
  if (!bitmap) return null;
  const c = blankCanvas(doc.width, doc.height);
  const x = c.getContext("2d")!;
  drawPixels(x, layer, bitmap);
  const mask = layer.mask && !layer.maskOff ? effectiveLayerMask(doc,layer) : undefined;
  if (mask) {
    x.globalCompositeOperation = "destination-in";
    x.drawImage(mask, 0, 0);
    if(layer.defringe===1){const pixels=x.getImageData(0,0,doc.width,doc.height);pixels.data.set(defringeOnePixel(pixels.data,doc.width,doc.height));x.putImageData(pixels,0,0);}
  }
  return c;
}

/** Show only some channels, as Photoshop's channel eyes do. Alpha alone is shown as grayscale. */
export function filterChannels(ctx: CanvasRenderingContext2D, w: number, h: number, ch: Channels) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const alphaOnly = ch.a && !ch.r && !ch.g && !ch.b;
  for (let i = 0; i < d.length; i += 4) {
    if (alphaOnly) {
      const a = d[i + 3];
      d[i] = d[i + 1] = d[i + 2] = a;
      d[i + 3] = 255;
      continue;
    }
    if (!ch.r) d[i] = 0;
    if (!ch.g) d[i + 1] = 0;
    if (!ch.b) d[i + 2] = 0;
    if (!ch.a) d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

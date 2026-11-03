import type {Layer as PsdLayer, Psd} from "ag-psd";
import {BLENDS, emptyDoc, newId, type Blend, type Doc, type Layer} from "./doc";
import {blankCanvas, getBitmap, setBitmap} from "./bitmaps";

const MAX_PIXELS = 16_777_216;
const MAX_BYTES = 256 * 1024 * 1024;

/** Decode only after the user chooses a PSD; normal editor loads need no PSD parser. */
export async function importPsd(file: File): Promise<{doc: Doc; warnings: string[]}> {
  if (file.size > MAX_BYTES) throw new Error("This PSD is larger than the 256 MB import limit.");
  const {readPsd} = await import("ag-psd");
  const psd = readPsd(await file.arrayBuffer(), {useImageData: true, skipThumbnail: true, skipLinkedFilesData: true, totalMemoryLimit: 512 * 1024 * 1024});
  return documentFromPsd(psd);
}

export function documentFromPsd(psd: Psd): {doc: Doc; warnings: string[]} {
  if (!psd.width || !psd.height || psd.width * psd.height > MAX_PIXELS) throw new Error("This PSD exceeds the 16-megapixel import limit.");
  const doc = emptyDoc(psd.width, psd.height);
  const groups: NonNullable<Doc["groups"]> = {};
  const warnings = new Set<string>();
  let maskPixels = 0;
  if ((psd.bitsPerChannel ?? 8) > 8) warnings.add("High bit-depth pixels were converted to 8-bit.");
  if (psd.colorMode === 4) warnings.add("CMYK colors were converted approximately to RGB.");
  const visit = (items: PsdLayer[], parent?: string, depth = 0) => {
    if (depth > 15) throw new Error("This PSD has more than 16 nested groups.");
    for (const item of items) {
      if (item.children) {
        const id = newId("g");
        const blend = item.blendMode === "pass through" ? "pass-through" : BLENDS.includes(item.blendMode as Blend) ? item.blendMode as Blend : "pass-through";
        if (item.blendMode && item.blendMode !== "pass through" && !BLENDS.includes(item.blendMode as Blend)) warnings.add("Some group blend modes are not supported.");
        groups[id] = {name: item.name || "Group", visible: !item.hidden, parent, opacity: item.opacity ?? 1, blend};
        if (item.mask || item.vectorMask || item.effects) warnings.add("Group masks or effects are not imported.");
        visit(item.children, id, depth + 1);
        continue;
      }
      if (item.vectorMask || item.realMask) warnings.add("Vector or additional layer masks are not imported.");
      if (item.effects) warnings.add("Layer effects are not imported.");
      if (item.text || item.placedLayer) warnings.add("Text and smart objects are imported as pixels where available.");
      if (item.adjustment) warnings.add("Adjustment layers may look different.");
      if (item.clipping) warnings.add("Clipping layers can look different from Photoshop, especially inside groups.");
      const pixels = item.imageData;
      if (!pixels || !pixels.width || !pixels.height) { warnings.add("Some layers have no importable pixel data."); continue; }
      if (doc.layers.length >= 128) throw new Error("This PSD exceeds the 128-layer limit.");
      const canvas = blankCanvas(pixels.width, pixels.height);
      const ctx = canvas.getContext("2d")!;
      const image = ctx.createImageData(pixels.width, pixels.height);
      if (pixels.data instanceof Uint16Array) {
        for (let i=0;i<pixels.data.length;i++) image.data[i] = Math.round(pixels.data[i] / 257);
      } else if (pixels.data instanceof Float32Array) {
        for (let i=0;i<pixels.data.length;i++) {
          const value = Math.max(0, Math.min(1, pixels.data[i]));
          image.data[i] = Math.round((i % 4 === 3 ? value : Math.pow(value, 1 / 2.2)) * 255);
        }
      } else image.data.set(pixels.data);
      ctx.putImageData(image, 0, 0);
      const src = newId("bmp:psd:"); setBitmap(src, canvas);
      const blend = BLENDS.includes(item.blendMode as Blend) ? item.blendMode as Blend : "normal";
      if (item.blendMode && !BLENDS.includes(item.blendMode as Blend)) warnings.add("Some layer blend modes are not supported.");
      const layer: Layer = {id:newId(), name:item.name || "Layer", kind:"image", src, w:pixels.width, h:pixels.height,
        x:(item.left ?? 0) + pixels.width / 2, y:(item.top ?? 0) + pixels.height / 2,
        scale:1, rotation:0, flipX:false, visible:!item.hidden, opacity:item.opacity ?? 1, blend,
        brightness:100, contrast:100, saturation:100, group:parent, clip:!!item.clipping,
        locks:item.transparencyProtected ? {transparent:true} : undefined};
      const mask = item.mask;
      if (mask?.imageData && maskPixels + doc.width * doc.height <= 67_108_864) {
        maskPixels += doc.width * doc.height;
        const canvas = blankCanvas(doc.width, doc.height), context = canvas.getContext("2d")!;
        const density = mask.userMaskDensity ?? 1;
        const background = Math.round(255 * (1 - density * (1 - (mask.defaultColor ?? 255) / 255)));
        context.fillStyle = `rgba(255,255,255,${background / 255})`;
        context.fillRect(0, 0, doc.width, doc.height);
        const pixels = mask.imageData;
        const image = context.createImageData(pixels.width, pixels.height);
        for (let i = 0; i < pixels.data.length; i += 4) {
          const sample = pixels.data[i] / (pixels.data instanceof Uint16Array ? 65535 : pixels.data instanceof Float32Array ? 1 : 255);
          image.data[i] = image.data[i+1] = image.data[i+2] = 255;
          image.data[i+3] = Math.round(255 * (1 - density * (1 - Math.max(0, Math.min(1, sample)))));
        }
        const offsetX = (mask.left ?? 0) + (mask.positionRelativeToLayer ? item.left ?? 0 : 0);
        const offsetY = (mask.top ?? 0) + (mask.positionRelativeToLayer ? item.top ?? 0 : 0);
        context.putImageData(image, offsetX, offsetY);
        layer.mask = newId("bmp:psd-mask:"); setBitmap(layer.mask, canvas);
        layer.maskOff = !!mask.disabled;
        if (mask.userMaskFeather || mask.fromVectorData) warnings.add("Mask feathering or vector masks are not imported.");
      } else if (mask) warnings.add("Some layer masks could not be imported.");
      doc.layers.push(layer);
    }
  };
  visit(psd.children ?? []);
  // Keep Photoshop's saved composite available for comparison when some
  // appearance information cannot be represented by editable layers.
  // It is hidden so it never covers the layers the user is editing.
  const needsReference = [...warnings].some(w => /effects|masks|Adjustment layers|blend modes|no importable pixel data/.test(w));
  let referenceId: string | undefined;
  if (doc.layers.length && needsReference && psd.imageData?.width === doc.width && psd.imageData.height === doc.height && doc.layers.length < 128) {
    visit([{name:"Photoshop composite (reference)", imageData:psd.imageData, hidden:true}]);
    referenceId = doc.layers.at(-1)?.id;
    warnings.add("The hidden Photoshop composite layer shows the saved appearance.");
  }
  if (!doc.layers.length) {
    if (!psd.imageData) throw new Error("This PSD has no importable layers or merged image.");
    const composite: PsdLayer = {name:"Merged image", imageData:psd.imageData};
    visit([composite]); warnings.add("Only the merged image was available.");
  }
  doc.groups = groups;
  doc.selectedId = [...doc.layers].reverse().find(layer => layer.id !== referenceId)?.id ?? null;
  return {doc, warnings:[...warnings]};
}

/** Add the PSD as layers without replacing the current document. */
export function placePsd(current: Doc, imported: Doc): Doc {
  if (current.layers.length + imported.layers.length > 128) throw new Error("Adding this PSD would exceed the 128-layer limit.");
  const scale = Math.min(1, current.width / imported.width, current.height / imported.height);
  const dx = (current.width - imported.width * scale) / 2, dy = (current.height - imported.height * scale) / 2;
  const layers = imported.layers.map(layer => {
    let mask = layer.mask;
    if (mask) {
      const source = getBitmap(mask);
      if (!source) throw new Error("An imported layer mask could not be loaded.");
      const canvas = blankCanvas(current.width, current.height);
      canvas.getContext("2d")!.drawImage(source, dx, dy, imported.width * scale, imported.height * scale);
      mask = newId("bmp:psd-mask:"); setBitmap(mask, canvas);
    }
    return {...layer, mask, x:dx + layer.x * scale, y:dy + layer.y * scale, scale:layer.scale * scale};
  });
  return {...current, layers:[...current.layers, ...layers], groups:{...current.groups, ...imported.groups}, selectedId:imported.selectedId};
}

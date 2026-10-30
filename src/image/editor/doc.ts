/* Image editor document model: pure data and pure functions. Pixels live in a bitmap registry (see bitmaps.ts);
   a layer only points at its bitmap by `src`, so history entries are cheap snapshots of this structure. */

export type Blend = "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten";
export type GroupBlend=Blend|"pass-through";
export const BLENDS: Blend[] = ["normal", "multiply", "screen", "overlay", "darken", "lighten"];
export const BLEND_LABELS: Record<Blend, string> = { normal: "Normal", multiply: "Multiply", screen: "Screen", overlay: "Overlay", darken: "Darken", lighten: "Lighten" };

export type Layer = {
  /** Source geometry for a document-space mask linked to this layer. */
  maskAnchor?:{x:number;y:number;scale:number;rotation:number;flipX:boolean};
  /** Editable embedded document; src is its transparent render cache. */
  smartObject?: Doc;
  id: string;
  name: string;
  kind: "image" | "paint" | "adjust";
  /** Key of the bitmap in the registry (a URL for loaded images, `bmp:<id>` for painted ones). */
  src: string;
  /** Natural bitmap size. */
  w: number;
  h: number;
  visible: boolean;
  opacity: number;
  blend: Blend;
  /** Center of the layer in document pixels. */
  x: number;
  y: number;
  scale: number;
  rotation: number;
  flipX: boolean;
  brightness: number;
  contrast: number;
  saturation: number;
  /** Which channels may be painted (Photoshop's lock modes). */
  locks?: Locks;
  /** Id of the group this layer belongs to (see Doc.groups). */
  group?: string;
  /** Drop shadow (Layer style). */
  shadow?: Shadow;
  /** Linked layers move together. */
  linked?: boolean;
  /** Layer mask: a document-sized bitmap key; white shows the layer, clear hides it. */
  mask?: string;
  /** The mask is switched off (shift-click its thumbnail). */
  maskOff?: boolean;
  /** Automatic Magic Eraser edge colour decontamination, in document pixels. */
  defringe?: 1;
  /** Clipped to the layer below (an adjustment then changes only that layer). */
  clip?: boolean;
  /** Extra adjustments (adjustment layers): hue rotation in degrees, amounts in %. */
  hue?: number;
  grayscale?: number;
  invert?: number;
  sepia?: number;
};

export type Locks = { transparent?: boolean; paint?: boolean; position?: boolean };
export type Shadow = { dx: number; dy: number; blur: number; color: string };

export type Doc = {
  width: number;
  height: number;
  layers: Layer[];
  selectedId: string | null;
  /** Bitmap key of the selection mask (alpha = selected), or null. */
  selection: string | null;
  /** Groups are folders of layers; hiding one hides its members. */
  groups?: Record<string, { name: string; visible: boolean; parent?: string;opacity?:number;blend?:GroupBlend }>;
  /** Saved selections, so a hard-won selection can be loaded again later. */
  saved?: Array<{ id: string; name: string; key: string }>;
};

export const MAX_SIDE = 2048;
let counter = 0;
export const newId = (prefix = "l") => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

export const emptyDoc = (width: number, height: number): Doc => ({ width, height, layers: [], selectedId: null, selection: null });

const base = (name: string, kind: Layer["kind"], src: string, w: number, h: number, doc: Doc, scale: number): Layer => ({
  id: newId(), name, kind, src, w, h, visible: true, opacity: 1, blend: "normal",
  x: doc.width / 2, y: doc.height / 2, scale, rotation: 0, flipX: false, brightness: 100, contrast: 100, saturation: 100,
});

/** The first image defines the document; its longest side is capped so editing stays fast. */
export function docFromImage(name: string, src: string, w: number, h: number): Doc {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const doc = emptyDoc(Math.round(w * k), Math.round(h * k));
  return addLayer(doc, base(name, "image", src, w, h, doc, k));
}

/** Later images are fitted inside the document, centered. */
export function addImageLayer(doc: Doc, name: string, src: string, w: number, h: number): Doc {
  if (doc.layers.length === 0) return docFromImage(name, src, w, h);
  const fit = Math.min(1, doc.width / w, doc.height / h);
  return addLayer(doc, base(name, "image", src, w, h, doc, fit));
}

export const addPaintLayer = (doc: Doc, src: string): Doc =>
  addLayer(doc, base(`Layer ${doc.layers.length + 1}`, "paint", src, doc.width, doc.height, doc, 1));

function addLayer(doc: Doc, layer: Layer): Doc {
  const above = doc.layers.findIndex((l) => l.id === doc.selectedId);
  const layers = doc.layers.slice();
  layers.splice(above < 0 ? layers.length : above + 1, 0, layer);
  return { ...doc, layers, selectedId: layer.id };
}

export function patchLayer(layer:Layer,patch:Partial<Layer>):Layer{
  const next={...layer,...patch};
  if("mask" in patch&&patch.mask!==layer.mask&&!('maskAnchor' in patch))next.maskAnchor=undefined;
  else if(layer.mask&&!layer.maskAnchor&&["x","y","scale","rotation","flipX"].some(key=>key in patch&&patch[key as keyof Layer]!==layer[key as keyof Layer]))next.maskAnchor={x:layer.x,y:layer.y,scale:layer.scale,rotation:layer.rotation,flipX:layer.flipX};
  return next;
}
export const updateLayer = (doc: Doc, id: string, patch: Partial<Layer>): Doc => ({
  ...doc,
  layers: doc.layers.map((l) => (l.id === id ? patchLayer(l,patch) : l)),
});

export function removeLayer(doc: Doc, id: string): Doc {
  const index = doc.layers.findIndex((l) => l.id === id);
  if (index < 0) return doc;
  const layers = doc.layers.filter((l) => l.id !== id);
  const next = layers[Math.min(index, layers.length - 1)];
  return pruneGroups({ ...doc, layers, selectedId: doc.selectedId === id ? next?.id ?? null : doc.selectedId });
}

export function duplicateLayer(doc: Doc, id: string, src?: string): Doc {
  const layer = doc.layers.find((l) => l.id === id);
  if (!layer) return doc;
  return addLayer(doc, { ...layer, id: newId(), name: `${layer.name} copy`, src: src ?? layer.src });
}

/** Layers are stored bottom to top: "up" moves toward the end. */
export function moveLayer(doc: Doc, id: string, direction: "up" | "down"): Doc {
  const index = doc.layers.findIndex((l) => l.id === id);
  const target = direction === "up" ? index + 1 : index - 1;
  if (index < 0 || target < 0 || target >= doc.layers.length) return doc;
  const layers = doc.layers.slice();
  [layers[index], layers[target]] = [layers[target], layers[index]];
  return { ...doc, layers };
}

export const selectLayer = (doc: Doc, id: string): Doc => (doc.layers.some((l) => l.id === id) ? { ...doc, selectedId: id } : doc);
export const selectedLayer = (doc: Doc) => doc.layers.find((l) => l.id === doc.selectedId) ?? null;

export const CROPS = { original: "Original", "1:1": "1:1", "4:3": "4:3", "16:9": "16:9", "9:16": "9:16" } as const;
export type CropId = keyof typeof CROPS;

/** Centered crop to an aspect ratio; layers keep their place relative to the picture. */
export function cropDoc(doc: Doc, crop: CropId): Doc {
  if (crop === "original" || doc.layers.length === 0) return doc;
  const [a, b] = crop.split(":").map(Number);
  const ratio = a / b;
  let width = doc.width;
  let height = Math.round(width / ratio);
  if (height > doc.height) {
    height = doc.height;
    width = Math.round(height * ratio);
  }
  const dx = (doc.width - width) / 2;
  const dy = (doc.height - height) / 2;
  return { ...doc, width, height, selection: null, layers: doc.layers.map((l) => ({ ...l, x: l.x - dx, y: l.y - dy })) };
}

export const flipLayer = (doc: Doc, id: string): Doc => {
  const layer = doc.layers.find((l) => l.id === id);
  return layer ? updateLayer(doc, id, { flipX: !layer.flipX }) : doc;
};

/** CSS/canvas filter string for a layer's tone adjustments. Empty when untouched. */
export function filterOf(layer: Pick<Layer, "brightness" | "contrast" | "saturation"> & Partial<Pick<Layer, "hue" | "grayscale" | "invert" | "sepia">>): string {
  const parts: string[] = [];
  if (layer.hue) parts.push(`hue-rotate(${layer.hue}deg)`);
  if (layer.grayscale) parts.push(`grayscale(${layer.grayscale}%)`);
  if (layer.invert) parts.push(`invert(${layer.invert}%)`);
  if (layer.sepia) parts.push(`sepia(${layer.sepia}%)`);
  if (layer.brightness !== 100) parts.push(`brightness(${layer.brightness}%)`);
  if (layer.contrast !== 100) parts.push(`contrast(${layer.contrast}%)`);
  if (layer.saturation !== 100) parts.push(`saturate(${layer.saturation}%)`);
  return parts.join(" ") || "none";
}

export const BLEND_OPERATION: Record<Blend, GlobalCompositeOperation> = {
  normal: "source-over", multiply: "multiply", screen: "screen", overlay: "overlay", darken: "darken", lighten: "lighten",
};

/** Map a document point into a layer's bitmap pixels (inverse of how the layer is drawn). */
export function toLayerPoint(layer: Layer, px: number, py: number): { x: number; y: number } {
  const dx = px - layer.x;
  const dy = py - layer.y;
  const r = (-layer.rotation * Math.PI) / 180;
  const rx = dx * Math.cos(r) - dy * Math.sin(r);
  const ry = dx * Math.sin(r) + dy * Math.cos(r);
  const s = layer.scale || 1;
  return { x: (layer.flipX ? -rx : rx) / s + layer.w / 2, y: ry / s + layer.h / 2 };
}

/* History: snapshots of the doc, capped. */
export type History = { past: Doc[]; present: Doc; future: Doc[]; continuous?: { key: string; at: number } };
const LIMIT = 40;
export const startHistory = (doc: Doc): History => ({ past: [], present: doc, future: [] });
export const commit = (h: History, doc: Doc): History => (doc === h.present ? h : { past: [...h.past, h.present].slice(-LIMIT), present: doc, future: [] });
export const undo = (h: History): History => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h);
export const redo = (h: History): History => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h);

/** Replace the present without a new undo step (a slider being dragged). */
export const replace = (h: History, doc: Doc): History => ({ past: h.past, present: doc, future: h.future });

/** Coalesce only adjacent changes to the same control. Undo, redo and other edits end the batch. */
export function commitContinuous(h: History, doc: Doc, key: string, at: number): History {
  if (doc === h.present) return h;
  const elapsed = at - (h.continuous?.at ?? 0);
  const same = h.continuous?.key === key && elapsed >= 0 && elapsed < 800 && h.future.length === 0;
  return { ...(same ? replace(h, doc) : commit(h, doc)), continuous: { key, at } };
}

/** Replace some layers by one merged layer (its pixels are rendered by the caller). It takes the place of the lowest one. */
export function mergeInto(doc: Doc, ids: string[], src: string, name: string, group?: string | null): Doc {
  const indexes = doc.layers.map((l, i) => (ids.includes(l.id) ? i : -1)).filter((i) => i >= 0);
  if (indexes.length < 2) return doc;
  const at = Math.min(...indexes);
  const selected=doc.layers.filter(layer=>ids.includes(layer.id));
  const sharedGroup=selected.length&&selected.every(layer=>layer.group===selected[0].group)?selected[0].group:undefined;
  const destinationGroup=group===undefined?sharedGroup:group??undefined;
  const merged: Layer = {
    id: newId(), name, kind: "paint", src, w: doc.width, h: doc.height, visible: true, opacity: 1, blend: "normal",
    x: doc.width / 2, y: doc.height / 2, scale: 1, rotation: 0, flipX: false, brightness: 100, contrast: 100, saturation: 100,
    group: destinationGroup && doc.groups?.[destinationGroup] ? destinationGroup : undefined,
  };
  const rest = doc.layers.filter((l) => !ids.includes(l.id));
  const before = doc.layers.slice(0, at).filter((l) => !ids.includes(l.id)).length;
  rest.splice(before, 0, merged);
  return pruneGroups({ ...doc, layers: rest, selectedId: merged.id });
}

/** Send a layer to the very top or bottom of the stack. */
export function moveLayerToEdge(doc: Doc, id: string, edge: "top" | "bottom"): Doc {
  const layer = doc.layers.find((l) => l.id === id);
  if (!layer) return doc;
  const rest = doc.layers.filter((l) => l.id !== id);
  return { ...doc, layers: edge === "top" ? [...rest, layer] : [layer, ...rest] };
}

export type AlignTo = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/** Align a layer to the picture edges or center (rotation is ignored, as for the X/Y/W/H fields). */
export function alignLayer(doc: Doc, id: string, to: AlignTo): Doc {
  const l = doc.layers.find((x) => x.id === id);
  if (!l) return doc;
  const hw = (l.w * l.scale) / 2;
  const hh = (l.h * l.scale) / 2;
  const patch: Partial<Layer> =
    to === "left" ? { x: hw } : to === "right" ? { x: doc.width - hw } : to === "hcenter" ? { x: doc.width / 2 }
    : to === "top" ? { y: hh } : to === "bottom" ? { y: doc.height - hh } : { y: doc.height / 2 };
  return updateLayer(doc, id, patch);
}

/** Crop the picture to a rectangle in document pixels; layers keep their place relative to the picture. */
export function cropToRect(doc: Doc, rect: { x: number; y: number; w: number; h: number }, snap = 1): Doc {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const width = Math.floor(Math.min(doc.width - x, Math.round(rect.w)) / snap) * snap;
  const height = Math.floor(Math.min(doc.height - y, Math.round(rect.h)) / snap) * snap;
  if (width < 8 || height < 8) return doc;
  return { ...doc, width, height, selection: null, layers: doc.layers.map((l) => ({ ...l, x: l.x - x, y: l.y - y })) };
}

/** Ordered from the layer's closest group to its outermost group. */
export function groupAncestors(doc:Doc,gid:string|undefined):string[]{
  const result:string[]=[],seen=new Set<string>();
  while(gid&&doc.groups?.[gid]&&!seen.has(gid)){result.push(gid);seen.add(gid);gid=doc.groups[gid].parent;}
  return result;
}
export function layerGroupIds(doc:Doc,l:Layer):string[]{return groupAncestors(doc,l.group);}
export function isGroupDescendant(doc:Doc,gid:string,candidate:string|undefined):boolean{return !!candidate&&groupAncestors(doc,candidate).includes(gid);}
export function pruneGroups(doc:Doc):Doc{
  if(!doc.groups)return doc;
  const live=new Set(doc.layers.flatMap(layer=>groupAncestors(doc,layer.group)));
  const groups=Object.fromEntries(Object.entries(doc.groups).filter(([gid])=>live.has(gid)));
  return {...doc,groups:Object.keys(groups).length?groups:undefined};
}
/** A layer is shown only when it and every enclosing folder are visible. */
export const isVisible = (doc: Doc, l: Layer) => l.visible && layerGroupIds(doc,l).every(gid=>doc.groups?.[gid]?.visible!==false);

export const ratioOf = (crop: CropId): number | null => {
  if (crop === "original") return null;
  const [a, b] = crop.split(":").map(Number);
  return a / b;
};

/** The centered rectangle of a picture for a ratio, as Photoshop's crop tool proposes it. */
export function aiCropRect(doc: Doc, crop: CropId): { x: number; y: number; w: number; h: number } {
  const ratio = ratioOf(crop);
  if (!ratio) return { x: 0, y: 0, w: doc.width, h: doc.height };
  let w = doc.width;
  let h = Math.round(w / ratio);
  if (h > doc.height) {
    h = doc.height;
    w = Math.round(h * ratio);
  }
  return { x: (doc.width - w) / 2, y: (doc.height - h) / 2, w, h };
}

export type AdjustKind = "brightness" | "hue" | "bw" | "invert" | "photo";
export const ADJUSTMENTS: Record<AdjustKind, { name: string; patch: Partial<Layer> }> = {
  brightness: { name: "Brightness/Contrast", patch: {} },
  hue: { name: "Hue/Saturation", patch: { hue: 0 } },
  bw: { name: "Black & White", patch: { grayscale: 100 } },
  invert: { name: "Invert", patch: { invert: 100 } },
  photo: { name: "Photo Filter", patch: { sepia: 60 } },
};

/** A new adjustment layer above the selection. clip = only the layer below is changed (Alt in Photoshop). */
export function addAdjustLayer(doc: Doc, kind: AdjustKind = "brightness", clip = false): Doc {
  const a = ADJUSTMENTS[kind];
  return addLayer(doc, { ...base(a.name, "adjust", "", doc.width, doc.height, doc, 1), ...a.patch, clip });
}

export function groupLayer(doc: Doc, id: string): Doc {
  const l = doc.layers.find((x) => x.id === id);
  if (!l || l.group) return doc;
  const gid = newId("g");
  const n = Object.keys(doc.groups ?? {}).length + 1;
  return {
    ...doc,
    groups: { ...(doc.groups ?? {}), [gid]: { name: `Group ${n}`, visible: true } },
    layers: doc.layers.map((x) => (x.id === id ? { ...x, group: gid } : x)),
  };
}

export function ungroupLayer(doc: Doc, id: string): Doc {
  const l = doc.layers.find((x) => x.id === id);
  if (!l?.group) return doc;
  const gid = l.group;
  const groups = { ...(doc.groups ?? {}) };
  if (!doc.layers.some((x) => x.id !== id && isGroupDescendant(doc,gid,x.group))&&!Object.values(groups).some(g=>g.parent===gid)) delete groups[gid];
  return pruneGroups({ ...doc, groups, layers: doc.layers.map((x) => (x.id === id ? { ...x, group: undefined } : x)) });
}

/** Dissolve a folder while keeping its layers and child folders inside its parent. */
export function ungroupGroup(doc:Doc,gid:string):Doc{
  const group=doc.groups?.[gid];if(!group)return doc;
  const groups={...doc.groups};delete groups[gid];
  for(const [id,child] of Object.entries(groups))if(child.parent===gid)groups[id]={...child,parent:group.parent};
  return {...doc,groups,layers:doc.layers.map(layer=>layer.group===gid?{...layer,group:group.parent}:layer)};
}

export function toggleGroup(doc: Doc, gid: string): Doc {
  const g = doc.groups?.[gid];
  if (!g) return doc;
  return { ...doc, groups: { ...doc.groups, [gid]: { ...g, visible: !g.visible } } };
}

/** A customized folder becomes one stack at its highest member; untouched legacy folders keep their order. */
export function updateGroup(doc:Doc,gid:string,patch:{opacity?:number;blend?:GroupBlend}):Doc{
  const group=doc.groups?.[gid];if(!group)return doc;
  if(patch.opacity!==undefined&&!Number.isFinite(patch.opacity))return doc;
  if(patch.blend!==undefined&&!["pass-through",...BLENDS].includes(patch.blend))return doc;
  const opacity=patch.opacity===undefined?group.opacity??1:Math.max(0,Math.min(1,patch.opacity)),blend=patch.blend??group.blend??"pass-through";
  if(opacity===(group.opacity??1)&&blend===(group.blend??"pass-through"))return doc;
  const members=doc.layers.filter(l=>isGroupDescendant(doc,gid,l.group)),highest=doc.layers.reduce((last,l,i)=>isGroupDescendant(doc,gid,l.group)?i:last,-1),rest=doc.layers.filter(l=>!isGroupDescendant(doc,gid,l.group));
  const at=doc.layers.slice(0,highest).filter(l=>!isGroupDescendant(doc,gid,l.group)).length;rest.splice(at,0,...members);
  return {...doc,layers:rest,groups:{...doc.groups,[gid]:{...group,opacity,blend}}};
}

/** Move a layer to the stack position that another layer (by id) has, as a drag and drop in the list does. */
export function reorderLayer(doc: Doc, id: string, targetId: string): Doc {
  if (id === targetId) return doc;
  const from = doc.layers.findIndex((l) => l.id === id);
  const to = doc.layers.findIndex((l) => l.id === targetId);
  if (from < 0 || to < 0) return doc;
  const layers = doc.layers.slice();
  const [moved] = layers.splice(from, 1);
  layers.splice(to, 0, moved);
  return { ...doc, layers };
}

/** Move a layer by a delta; if it is linked, every linked layer that is not position-locked moves with it. */
export function moveWithLinks(doc: Doc, id: string, dx: number, dy: number): Doc {
  const moved = doc.layers.find((l) => l.id === id);
  if (!moved) return doc;
  return {
    ...doc,
    layers: doc.layers.map((l) => (l.id === id || (moved.linked && l.linked && !l.locks?.position) ? patchLayer(l,{x:l.x+dx,y:l.y+dy}) : l)),
  };
}

export const GROUP_DEPTH_LIMIT=16;
export type GroupSelectionState="available"|"already-grouped"|"depth-limit";
export function groupSelectionState(doc:Doc,ids:string[]):GroupSelectionState{
  const selected=doc.layers.filter(layer=>ids.includes(layer.id));
  if(!selected.length)return "available";
  const roots=new Set(selected.flatMap(layer=>layer.group?groupAncestors(doc,layer.group).slice(-1):[]));
  if(roots.size===1&&selected.every(layer=>layer.group&&groupAncestors(doc,layer.group).at(-1)===[...roots][0]))return "already-grouped";
  if(doc.layers.some(layer=>{const chain=groupAncestors(doc,layer.group);return chain.length>=GROUP_DEPTH_LIMIT&&roots.has(chain.at(-1)!);}))return "depth-limit";
  return "available";
}

/** Wrap selected layers and any existing folder units in a new parent group. */
export function groupLayers(doc: Doc, ids: string[]): Doc {
  if(groupSelectionState(doc,ids)!=="available")return doc;
  const members = doc.layers.filter((l) => ids.includes(l.id));
  if (!members.length) return doc;
  const gid = newId("g");
  const n = Object.keys(doc.groups ?? {}).length + 1;
  const roots=new Set(members.flatMap(layer=>layer.group?groupAncestors(doc,layer.group).slice(-1):[]));
  return {
    ...doc,
    groups: Object.fromEntries(Object.entries({...doc.groups,[gid]:{name:`Group ${n}`,visible:true}}).map(([id,g])=>[id,roots.has(id)?{...g,parent:gid}:g])),
    layers: doc.layers.map((l) => (l.group ? l : members.some((m) => m.id === l.id) ? { ...l, group: gid } : l)),
  };
}

import { describe, expect, it } from "vitest";
import { addImageLayer, commit, commitContinuous, cropDoc, docFromImage, duplicateLayer, filterOf, moveLayer, redo, removeLayer, replace, selectedLayer, startHistory, toLayerPoint, undo, updateLayer } from "../src/image/editor/doc";

describe("continuous editor history", () => {
  const original = docFromImage("image", "test:source", 100, 100);
  const change = (h: ReturnType<typeof startHistory>, opacity: number, at: number) =>
    commitContinuous(h, updateLayer(h.present, original.selectedId!, { opacity }), "opacity", at);

  it("undoes an entire slider drag in one step and redoes its final value", () => {
    const h = change(change(startHistory(original), 0.8, 1000), 0.5, 1100);
    expect(h.past).toEqual([original]);
    expect(undo(h).present).toBe(original);
    expect(redo(undo(h)).present.layers[0].opacity).toBe(0.5);
  });

  it("starts a new branch after undo even inside the coalescing interval", () => {
    const h = change(undo(change(startHistory(original), 0.8, 1000)), 0.4, 1100);
    expect(h.future).toEqual([]);
    expect(undo(h).present).toBe(original);
    expect(redo(h)).toBe(h);
  });

  it("does not absorb a change made immediately after redo", () => {
    const restored = redo(undo(change(startHistory(original), 0.8, 1000)));
    const h = change(restored, 0.4, 1100);
    expect(undo(h).present.layers[0].opacity).toBe(0.8);
    expect(undo(undo(h)).present).toBe(original);
  });

  it("keeps an intervening layer edit separate", () => {
    let h = change(startHistory(original), 0.8, 1000);
    h = commit(h, updateLayer(h.present, original.selectedId!, { name: "Renamed" }));
    h = change(h, 0.4, 1100);
    expect(undo(h).present.layers[0]).toMatchObject({ name: "Renamed", opacity: 0.8 });
    expect(undo(undo(h)).present.layers[0].name).toBe("image");
  });

  it("ends a batch after a gesture replacement or a pause", () => {
    let h = change(startHistory(original), 0.8, 1000);
    h = replace(h, updateLayer(h.present, original.selectedId!, { x: 20 }));
    expect(undo(change(h, 0.4, 1100)).present.layers[0]).toMatchObject({ x: 20, opacity: 0.8 });
    expect(change(h, 0.4, 2000).past).toHaveLength(2);
  });
});

describe("image editor document", () => {
  it("caps the first image and centers it", () => {
    const doc = docFromImage("a", "u", 4096, 2048);
    expect(doc.width).toBe(2048);
    expect(doc.height).toBe(1024);
    expect(doc.layers[0].scale).toBe(0.5);
    expect(doc.layers[0].x).toBe(1024);
  });

  it("adds layers above the selection, reorders and removes them", () => {
    let doc = docFromImage("a", "u1", 100, 100);
    doc = addImageLayer(doc, "b", "u2", 400, 100);
    expect(doc.layers.map((l) => l.name)).toEqual(["a", "b"]);
    expect(doc.layers[1].scale).toBe(0.25);
    const b = doc.layers[1].id;
    doc = moveLayer(doc, b, "down");
    expect(doc.layers.map((l) => l.name)).toEqual(["b", "a"]);
    doc = removeLayer(doc, b);
    expect(doc.layers).toHaveLength(1);
    expect(selectedLayer(doc)?.name).toBe("a");
  });

  it("crops to an aspect ratio and keeps layers in place relative to the picture", () => {
    let doc = docFromImage("a", "u", 1600, 900);
    doc = cropDoc(doc, "1:1");
    expect([doc.width, doc.height]).toEqual([900, 900]);
    expect(doc.layers[0].x).toBe(450);
  });

  it("builds a filter only for touched adjustments", () => {
    expect(filterOf({ brightness: 100, contrast: 100, saturation: 100 })).toBe("none");
    expect(filterOf({ brightness: 120, contrast: 100, saturation: 0 })).toBe("brightness(120%) saturate(0%)");
  });

  it("maps a document point into layer pixels through scale, rotation and flip", () => {
    const doc = docFromImage("a", "u", 100, 100);
    const l = updateLayer(doc, doc.layers[0].id, { scale: 2, x: 200, y: 200 }).layers[0];
    expect(toLayerPoint(l, 200, 200)).toEqual({ x: 50, y: 50 });
    expect(toLayerPoint(l, 300, 200).x).toBeCloseTo(100);
    const turned = { ...l, rotation: 90 };
    expect(toLayerPoint(turned, 200, 300).x).toBeCloseTo(100);
  });

  it("duplicates with a new bitmap and undoes and redoes", () => {
    let h = startHistory(docFromImage("a", "u", 10, 10));
    const id = h.present.layers[0].id;
    h = commit(h, duplicateLayer(h.present, id, "bmp:copy"));
    expect(h.present.layers).toHaveLength(2);
    expect(h.present.layers[1].src).toBe("bmp:copy");
    h = undo(h);
    expect(h.present.layers).toHaveLength(1);
    h = redo(h);
    expect(h.present.layers).toHaveLength(2);
  });
});

import { mergeInto, moveLayerToEdge } from "../src/image/editor/doc";
describe("layer stack shortcuts", () => {
  it("merges layers into one at the lowest place and sends layers to the edges", () => {
    let doc = docFromImage("a", "u1", 100, 100);
    doc = addImageLayer(doc, "b", "u2", 100, 100);
    doc = addImageLayer(doc, "c", "u3", 100, 100);
    const [a, b, c] = doc.layers.map((l) => l.id);
    const merged = mergeInto(doc, [b, c], "bmp:m", "b");
    expect(merged.layers.map((l) => l.name)).toEqual(["a", "b"]);
    expect(merged.layers[1].src).toBe("bmp:m");
    expect(moveLayerToEdge(doc, a, "top").layers.map((l) => l.name)).toEqual(["b", "c", "a"]);
    expect(moveLayerToEdge(doc, c, "bottom").layers.map((l) => l.name)).toEqual(["c", "a", "b"]);
  });
});

import { aiCropRect, addAdjustLayer, cropToRect, groupLayer, groupLayers, isVisible, toggleGroup, ungroupLayer, updateGroup } from "../src/image/editor/doc";
import { ratioPoint } from "../src/image/editor/selection";
describe("crop, groups and adjustment layers", () => {
  it("crops to AI-ready sizes that are multiples of 8", () => {
    const doc = docFromImage("a", "u", 100, 100);
    const cropped = cropToRect(doc, { x: 0, y: 0, w: 61, h: 45 }, 8);
    expect([cropped.width, cropped.height]).toEqual([56, 40]);
    expect(aiCropRect(doc, "16:9")).toMatchObject({ w: 100, h: 56 });
  });

  it("constrains a drag to a ratio", () => {
    expect(ratioPoint({ x: 0, y: 0 }, { x: 100, y: 10 }, 1)).toEqual({ x: 10, y: 10 });
  });

  it("groups layers and hides their members with the group", () => {
    let doc = docFromImage("a", "u1", 10, 10);
    doc = addImageLayer(doc, "b", "u2", 10, 10);
    const id = doc.layers[1].id;
    doc = groupLayer(doc, id);
    const gid = doc.layers[1].group!;
    expect(isVisible(doc, doc.layers[1])).toBe(true);
    doc = toggleGroup(doc, gid);
    expect(isVisible(doc, doc.layers[1])).toBe(false);
    expect(isVisible(doc, doc.layers[0])).toBe(true);
    doc = ungroupLayer(doc, id);
    expect(doc.groups?.[gid]).toBeUndefined();
  });

  it("stores bounded group opacity and blend while preserving surrounding stack order", () => {
    let doc = docFromImage("a", "u1", 10, 10);
    doc = addImageLayer(doc, "outside", "u2", 10, 10);
    doc = addImageLayer(doc, "b", "u3", 10, 10);
    doc = addImageLayer(doc, "c", "u4", 10, 10);
    const [a, outside, b, c] = doc.layers.map((l) => l.id);
    doc = groupLayers(doc, [a, b]);
    const gid = doc.layers[0].group!;
    const changed = updateGroup(doc, gid, { opacity: 0.4, blend: "multiply" });
    expect(changed.groups?.[gid]).toMatchObject({ opacity: 0.4, blend: "multiply" });
    expect(changed.layers.map((l) => l.id)).toEqual([outside, a, b, c]);
    expect(updateGroup(doc, gid, { opacity: -1 }).groups?.[gid].opacity).toBe(0);
    expect(updateGroup(doc, gid, { opacity: 2 })).toBe(doc);
    expect(updateGroup(doc, gid, { opacity: Number.NaN })).toBe(doc);
    expect(updateGroup(doc, "missing", { opacity: 0.5 })).toBe(doc);
    expect(updateGroup(changed, gid, { opacity: 0.4, blend: "multiply" })).toBe(changed);
  });

  it("adds an adjustment layer above the selection", () => {
    const doc = addAdjustLayer(docFromImage("a", "u", 10, 10));
    expect(doc.layers[doc.layers.length - 1].kind).toBe("adjust");
  });
});

import { reorderLayer } from "../src/image/editor/doc";
describe("layer drag and drop", () => {
  it("moves a dragged layer to the target's position", () => {
    let doc = docFromImage("a", "u1", 10, 10);
    doc = addImageLayer(doc, "b", "u2", 10, 10);
    doc = addImageLayer(doc, "c", "u3", 10, 10);
    const [a, , c] = doc.layers.map((l) => l.id);
    expect(reorderLayer(doc, c, a).layers.map((l) => l.name)).toEqual(["c", "a", "b"]);
  });
});

import { moveWithLinks } from "../src/image/editor/doc";
describe("linked layers", () => {
  it("moves linked layers together and leaves others", () => {
    let doc = docFromImage("a", "u1", 10, 10);
    doc = addImageLayer(doc, "b", "u2", 10, 10);
    doc = addImageLayer(doc, "c", "u3", 10, 10);
    const [a, b] = doc.layers.map((l) => l.id);
    doc = updateLayer(updateLayer(doc, a, { linked: true }), b, { linked: true });
    const moved = moveWithLinks(doc, a, 5, 0);
    expect(moved.layers.map((l) => l.x)).toEqual([10, 10, 5]);
  });
});

import { addAdjustLayer as addAdjust, resetAdjustment } from "../src/image/editor/doc";
describe("adjustment kinds and clipping", () => {
  it("creates a clipped Black & White adjustment and builds its filter", () => {
    const doc = addAdjust(docFromImage("a", "u", 10, 10), "bw", true);
    const adj = doc.layers[doc.layers.length - 1];
    expect(adj).toMatchObject({ kind: "adjust", clip: true, grayscale: 100, name: "Black & White" });
    expect(filterOf(adj)).toBe("grayscale(100%)");
  });

  it("restores an adjustment to its creation preset", () => {
    const photo=addAdjust(docFromImage("a","u",10,10),"photo").layers.at(-1)!;
    expect(resetAdjustment({...photo,brightness:42,contrast:8,saturation:180,sepia:7})).toEqual({brightness:100,contrast:100,saturation:100,sepia:60});
  });
});

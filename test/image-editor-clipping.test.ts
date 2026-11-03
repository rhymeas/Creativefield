import {describe, expect, it} from "vitest";
import {addImageLayer, emptyDoc, updateLayer} from "../src/image/editor/doc";
import {clipBase} from "../src/image/editor/render";

describe("clipping base", () => {
  it("keeps a clipping stack tied to its base when that base is hidden", () => {
    let doc = emptyDoc(20, 20);
    doc = addImageLayer(doc, "Background", "background", 20, 20);
    doc = addImageLayer(doc, "Base", "base", 20, 20);
    doc = addImageLayer(doc, "Clipped", "clipped", 20, 20);
    const [, base, clipped] = doc.layers;
    doc = updateLayer(doc, clipped.id, {clip:true});
    expect(clipBase(doc, 2)?.id).toBe(base.id);
    doc = updateLayer(doc, base.id, {visible:false});
    expect(clipBase(doc, 2)).toBeUndefined();
    doc = updateLayer(doc, base.id, {visible:true});
    expect(clipBase(doc, 2)?.id).toBe(base.id);
  });
});

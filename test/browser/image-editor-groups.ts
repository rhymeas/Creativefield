import { blankCanvas, setBitmap } from "../../src/image/editor/bitmaps";
import { addImageLayer, docFromImage, groupLayers, mergeInto, toggleGroup, updateGroup, updateLayer } from "../../src/image/editor/doc";
import { groupMergeSource, mergeLayerIds } from "../../src/image/editor/layer-actions";
import { renderDoc } from "../../src/image/editor/render";

export function runGroupChecks() {
  const passed: string[] = [], check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  const pixel = (canvas: HTMLCanvasElement, x = 4, y = 4) => Array.from(canvas.getContext("2d")!.getImageData(x, y, 1, 1).data);
  const bitmap = (color: string, width = 16, height = 12) => {
    const canvas = blankCanvas(width, height), ctx = canvas.getContext("2d")!;
    ctx.fillStyle = color; ctx.fillRect(0, 0, width, height); return canvas;
  };
  const composite = (doc: ReturnType<typeof docFromImage>) => {
    const canvas = blankCanvas(doc.width, doc.height); renderDoc(canvas.getContext("2d")!, doc); return canvas;
  };

  let doc = docFromImage("Transparent", "group:base", 16, 12);
  setBitmap("group:base", blankCanvas(16, 12));
  doc = addImageLayer(doc, "Blue", "group:blue", 16, 12);
  const blue = blankCanvas(16, 12); blue.getContext("2d")!.fillStyle = "blue"; blue.getContext("2d")!.fillRect(0, 0, 8, 12);
  setBitmap("group:blue", blue);
  doc = addImageLayer(doc, "Red", "group:red", 16, 12);
  setBitmap("group:red", bitmap("red"));
  const ids = doc.layers.slice(1).map(layer => layer.id), gid = (doc = groupLayers(doc, ids)).layers[1].group!;
  doc = updateGroup(doc, gid, { opacity: 0.5 });
  const alphaPixel = pixel(composite(doc));
  check(Math.abs(alphaPixel[3] - 128) <= 1 && Math.abs(pixel(composite(doc), 12, 4)[3] - 128) <= 1, `Group opacity should apply once across overlaps and single opaque children; got ${alphaPixel}.`);
  check(doc.layers.slice(1).every(layer => layer.opacity === 1), "Group opacity must not change child opacity.");
  passed.push("group opacity applies once to the combined transparent result");

  let backdrop = docFromImage("Gray", "group:gray", 16, 12);
  setBitmap("group:gray", bitmap("rgb(128,128,128)"));
  backdrop = addImageLayer(backdrop, "Multiply red", "group:multiply-red", 16, 12);
  setBitmap("group:multiply-red", bitmap("red"));
  const redId = backdrop.layers[1].id;
  backdrop = updateLayer(backdrop, redId, { blend: "multiply" });
  const multiplyGroup = (backdrop = groupLayers(backdrop, [redId])).layers[1].group!;
  backdrop = updateGroup(backdrop, multiplyGroup, { opacity: 0.5, blend: "pass-through" });
  const pass = pixel(composite(backdrop));
  check(pass.every((value, i) => Math.abs(value - [128, 64, 64, 255][i]) <= 1), `Pass-through should blend child against the backdrop before group opacity; got ${pass}.`);
  backdrop = updateGroup(backdrop, multiplyGroup, { blend: "normal" });
  const isolated = pixel(composite(backdrop));
  check(isolated.every((value, i) => Math.abs(value - [192, 64, 64, 255][i]) <= 1), `Normal group blend should isolate its children; got ${isolated}.`);
  passed.push("pass-through and isolated normal group blends differ as expected");

  backdrop = updateGroup(backdrop, multiplyGroup, { blend: "multiply" });
  const groupMultiply = pixel(composite(backdrop));
  check(groupMultiply.every((value, i) => Math.abs(value - [128, 64, 64, 255][i]) <= 1), `Group multiply should apply to the flattened group result; got ${groupMultiply}.`);
  passed.push("group blend mode applies to the flattened result");

  let nested=docFromImage("Transparent","nested:base",16,12);setBitmap("nested:base",blankCanvas(16,12));
  nested=addImageLayer(nested,"Blue","nested:blue",16,12);setBitmap("nested:blue",blue);
  nested=addImageLayer(nested,"Red","nested:red",16,12);setBitmap("nested:red",bitmap("red"));
  const [baseId,blueId,nestedRedId]=nested.layers.map(layer=>layer.id);
  nested=groupLayers(nested,[blueId,nestedRedId]);const childId=nested.layers.find(layer=>layer.id===blueId)!.group!;
  nested=groupLayers(nested,[baseId,blueId]);const parentId=nested.layers.find(layer=>layer.id===baseId)!.group!;
  nested=updateGroup(nested,parentId,{opacity:0.5});
  const nestedAlpha=pixel(composite(nested))[3];
  check(Math.abs(nestedAlpha-128)<=1,`Nested parent opacity should apply once to its visible subtree; got alpha ${nestedAlpha}.`);
  passed.push("nested parent opacity applies once across child groups");
  const beforeMerge=pixel(composite(nested)),mergeIds=mergeLayerIds(nested,[blueId],"group"),mergeCanvas=blankCanvas(nested.width,nested.height);
  renderDoc(mergeCanvas.getContext("2d")!,groupMergeSource(nested,mergeIds,childId));setBitmap("nested:merged",mergeCanvas);
  const mergedNested=mergeInto(nested,mergeIds,"nested:merged","Merged",parentId),afterMerge=pixel(composite(mergedNested));
  check(afterMerge.every((value,i)=>Math.abs(value-beforeMerge[i])<=1),`Merging a nested folder must preserve its parent opacity exactly once; before ${beforeMerge}, after ${afterMerge}.`);
  passed.push("merging a nested folder preserves parent opacity once");
  nested=toggleGroup(nested,childId);
  const hiddenChildAlpha=pixel(composite(nested))[3];
  check(hiddenChildAlpha===0,`Hiding the nested child should not resurrect hidden descendants in the parent; got alpha ${hiddenChildAlpha}.`);
  passed.push("hidden nested child remains hidden during parent compositing");
  return passed;
}

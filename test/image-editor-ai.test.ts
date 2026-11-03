import { describe, expect, it } from "vitest";
import { aiInstruction, selectionInstruction, coverSource, fiboOutputPlacement, padRect, requestsObjectRemoval, requestsObjectResize, resolveEditMode, resolveEditScope } from "../src/image/editor/ai";
import {addAiResultLayer} from "../src/image/editor/ai-layer";
import {docFromImage,startHistory,commit,undo,redo} from "../src/image/editor/doc";

describe("image editor AI helpers", () => {
  it("recognizes object removal requests for the selected region",()=>{
    for(const prompt of ["remove", "remove the pumpkin", "delete this", "entferne den Kürbis", "lösche das"]) expect(requestsObjectRemoval(prompt)).toBe(true);
    expect(requestsObjectRemoval("make the pumpkin smaller")).toBe(false);
    expect(requestsObjectRemoval("do not remove the pumpkin")).toBe(false);
  });
  it("recognizes explicit object size changes without changing ordinary edits",()=>{
    for(const prompt of ["make the rat smaller", "shrink the chair", "die Maus kleiner machen", "mach die Katze größer"]) expect(requestsObjectResize(prompt)).toBe(true);
    expect(requestsObjectResize("make the rat realistic")).toBe(false);
  });
  it("interprets a bare remove as removing the selected object only",()=>{
    expect(selectionInstruction("remove",true)).toContain("reconstruct the background");
    expect(selectionInstruction("entfernen",true)).toContain("selected object");
    expect(selectionInstruction("remove",false)).toBe("remove");
    expect(selectionInstruction("remove the hat",true)).toBe("remove the hat");
  });
  it("edits the scene for seasonal requests while retaining local element scope",()=>{
    for(const prompt of ["imagine this image as summer","image the scene in summer","summer instead of winter","Sommer statt Winter","change the whole image to night","replace the background"])
      expect(resolveEditScope("auto",prompt)).toBe("image");
    for(const prompt of ["make the jacket blue","add a red scarf","give the hair summer colours"])
      expect(resolveEditScope("auto",prompt)).toBe("layer");
    expect(resolveEditScope("layer","summer instead of winter")).toBe("layer");
    expect(resolveEditScope("auto","replace the background",true)).toBe("layer");
    expect(resolveEditScope("auto","make the selected scene summer",true)).toBe("layer");
    expect(resolveEditScope("auto","imagine this image as summer",true)).toBe("image");
    expect(resolveEditMode("auto","replace the background with an ocean",true)).toBe("fill");
    expect(resolveEditMode("auto","Hintergrund ersetzen",true)).toBe("fill");
    expect(resolveEditScope("image","make it blue")).toBe("image");
    expect(aiInstruction("modify","imagine this image as summer")).toContain("melt all lake and river ice");
    expect(aiInstruction("modify","make the jacket blue")).not.toContain("melt all");
    expect(aiInstruction("modify","winter instead of summer")).not.toContain("melt all");
  });
  it("routes one freeform edit action and respects explicit intent",()=>{
    expect(resolveEditMode("auto","make the jacket blue",true)).toBe("modify");
    expect(resolveEditMode("auto","add a red scarf",true)).toBe("fill");
    expect(resolveEditMode("auto","add a red scarf",false)).toBe("modify");
    expect(resolveEditMode("auto","match the lighting",false)).toBe("harmonize");
    expect(resolveEditMode("modify","fill this with blue",true)).toBe("modify");
    expect(resolveEditMode("fill","anything",false)).toBe("modify");
    expect(aiInstruction("modify","add a new scarf")).not.toContain("Do not keep the original face");
    expect(aiInstruction("modify","replace the background")).not.toContain("Do not keep the original face");
    expect(aiInstruction("modify","replace the character")).toContain("Do not keep the original face");
  });
  it("adds a cropped result at its document position without changing the source",()=>{
    const source=docFromImage("Original","source",120,80),before=structuredClone(source);
    const next=addAiResultLayer(source,"result","Modify",{x:31,y:17,w:20,h:12});
    expect(next.layers.at(-1)).toMatchObject({src:"result",name:"Modify",w:20,h:12,x:41,y:23,scale:1,rotation:0});
    expect(source).toEqual(before);expect(next.layers[0]).toEqual(before.layers[0]);
    const history=commit(startHistory(source),next);expect(undo(history).present).toEqual(source);expect(redo(undo(history)).present).toEqual(next);
  });

  it("keeps whole-image result placement when no cutout bounds are supplied",()=>{
    const next=addAiResultLayer(docFromImage("Original","source",120,80),"result","Harmonize");
    expect(next.layers.at(-1)).toMatchObject({w:120,h:80,x:60,y:40});
  });
  it("pads a selection for context and clamps it to the picture", () => {
    expect(padRect({ x: 10, y: 10, w: 100, h: 50 }, 200, 100, 0.2)).toEqual({ x: 0, y: 0, w: 130, h: 80 });
  });

  it("covers a target without distortion", () => {
    const src = coverSource(1000, 1000, { x: 0, y: 0, w: 200, h: 100 });
    expect(src.w / src.h).toBeCloseTo(2);
    expect(src.x).toBe(0);
  });

  it("undoes Fibo's integer center crop, including non-grid dimensions and Python rounding", () => {
    expect(fiboOutputPlacement({x:7,y:9,w:101,h:79},96,80)).toEqual({x:10,y:9,w:95,h:79});
    expect(fiboOutputPlacement({x:7,y:9,w:79,h:101},80,96)).toEqual({x:7,y:12,w:79,h:95});
    expect(fiboOutputPlacement({x:0,y:0,w:9,h:8},8,8)).toEqual({x:0,y:0,w:9,h:8});
    expect(fiboOutputPlacement({x:0,y:0,w:11,h:8},8,8)).toEqual({x:2,y:0,w:7,h:8});
  });

  it("builds the instructions for each action", () => {
    expect(aiInstruction("modify", "make it night.")).toContain("Apply the requested change fully");
    for(const prompt of ["make this character a female soccer player","turn the chair into a sofa"]){
      const instruction=aiInstruction("modify",prompt);
      expect(instruction).toContain(prompt);
      expect(instruction).toContain("rather than a blend");
      expect(instruction).toContain("Keep unrelated parts unchanged");
    }
    expect(aiInstruction("modify", "imagine a different character")).toMatch(/Do not keep the original face/);
    expect(aiInstruction("harmonize", "")).toMatch(/^Harmonize this composite/);
    expect(aiInstruction("fill", "a red scarf")).toMatch(/^a red scarf\. Blend it naturally/);
  });
});

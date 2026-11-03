import {describe,expect,it} from "vitest";
import {characterDropId,characterPlacementRect,characterPlacementInstruction,characterSwapInstruction} from "../src/image/editor/character-placement";
import {identityReferenceInstruction,identityReferenceSheetInstruction} from "../src/image/editor/character-references";

const id="00000000-0000-4000-8000-000000000001";
describe("reviewed character placement",()=>{
  it("addresses each reference view by its Qwen image token and asks for one scene",()=>{
    const three=identityReferenceInstruction(3);
    for(const token of ["<image1>","<image2>","<image3>","<image4>"])expect(three).toContain(token);
    expect(three).toContain("exactly one coherent scene");
    expect(three).not.toContain("<image5>");
    expect(identityReferenceInstruction(1)).toContain("<image2>");
    expect(identityReferenceInstruction(1)).not.toContain("<image3>");
    expect(identityReferenceInstruction(0)).toBe("");
    const sheet=identityReferenceSheetInstruction(3);
    expect(sheet).toContain("<image1>");
    expect(sheet).toContain("<image2>");
    expect(sheet).not.toContain("<image3>");
    expect(sheet).toContain("single reference sheet containing 3 views");
    expect(sheet).toContain("exactly one coherent photograph");
  });
  it("accepts opaque character IDs and rejects unrelated or malformed drag data",()=>{
    expect(characterDropId(id)).toBe(id);
    expect(characterDropId("",`character:${id}`)).toBe(id);
    expect(characterDropId("",`asset:${id}`)).toBeNull();
    expect(characterDropId("not-a-character",`character:${id}`)).toBeNull();
    expect(characterDropId(JSON.stringify({id,projectId:"other"}))).toBeNull();
  });
  it("creates a source-aligned review area centered on the drop",()=>{
    expect(characterPlacementRect(1000,800,{x:.5,y:.5})).toEqual({x:380,y:180,w:240,h:440});
    expect(characterPlacementRect(1000,800,{x:.25,y:.25})).toEqual({x:130,y:0,w:240,h:440});
  });
  it("keeps edge drops inside the image and rejects invalid geometry",()=>{
    for(const point of [{x:0,y:0},{x:1,y:1},{x:-2,y:5}]){
      const rect=characterPlacementRect(101,77,point);
      expect(rect.x).toBeGreaterThanOrEqual(0);expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x+rect.w).toBeLessThanOrEqual(101);expect(rect.y+rect.h).toBeLessThanOrEqual(77);
    }
    expect(characterPlacementRect(1,1,{x:1,y:1})).toEqual({x:0,y:0,w:1,h:1});
    expect(()=>characterPlacementRect(0,800,{x:.5,y:.5})).toThrow();
    expect(()=>characterPlacementRect(1000,800,{x:NaN,y:.5})).toThrow();
  });
  it("keeps identity/reference instructions separate from the scene note",()=>{
    const prompt=characterPlacementInstruction('Ari "night"',"  Use warm light  ");
    expect(prompt).toContain('"Ari \\"night\\""'.replaceAll('\\\\','\\'));
    expect(prompt).toContain("inside the selected region");
    expect(prompt).toContain("Use all supplied character references");
    expect(prompt).toMatch(/Use warm light$/);
  });
  it("provides a masked-person swap prompt without inventing another pipeline",()=>{
    const prompt=characterSwapInstruction("Ari","  Keep the coat  ");
    expect(prompt).toContain('Replace the person inside the selected region with the character "Ari"');
    expect(prompt).toContain("Preserve the reference face, hair, skin tone and clothing");
    expect(prompt).toContain("Keep everything outside the selected region unchanged");
    expect(prompt).toMatch(/Keep the coat$/);
  });
});

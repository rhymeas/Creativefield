import {describe,expect,it} from "vitest";
import {intentImageReferenceTarget,intentReferenceDraft} from "../src/team/intent/reference";

describe("intent reference handoff",()=>{
  it("keeps the active compatible edit model, including FLUX, and uses only ready image inputs",()=>{
    const fibo={id:"fibo2-edit",inputs:[{id:"source_image",type:"image"}]};
    const flux={id:"flux2-klein-edit",inputs:[{id:"source_image",type:"image"}]};
    const qwen={id:"qwen-image-21-edit",inputs:[{id:"source_image",type:"image"}]};
    expect(intentImageReferenceTarget([fibo,flux,qwen],flux.id)).toBe(flux);
    expect(intentImageReferenceTarget([fibo,flux,qwen],qwen.id)).toBe(qwen);
    expect(intentImageReferenceTarget([fibo],flux.id)).toBe(fibo);
    expect(intentImageReferenceTarget([{id:flux.id,inputs:[{id:"source_image",type:"video"}]}])).toBeUndefined();
  });
  it("keeps existing settings while inserting an image and instruction",()=>{
    const draft={inputs:{other:"asset-2"},controls:{prompt:"default prompt",seed:42},elementInputs:{}};
    const next=intentReferenceDraft(draft,"source_image","asset-1","Change the jacket","default prompt");
    expect(next).toEqual({inputs:{other:"asset-2",source_image:"asset-1"},controls:{prompt:"Change the jacket",seed:42},elementInputs:{}});
    expect(draft.inputs).toEqual({other:"asset-2"});
  });
  it("refuses to replace a different source, element reference or user prompt",()=>{
    expect(()=>intentReferenceDraft({inputs:{start_image:"existing"},controls:{prompt:""}},"start_image","new","Animate","")).toThrow(/source/);
    expect(()=>intentReferenceDraft({elementInputs:{start_image:{assetId:"existing"}},controls:{prompt:""}},"start_image","new","Animate","")).toThrow(/source/);
    expect(()=>intentReferenceDraft({controls:{prompt:"A saved idea"}},"start_image","new","Animate","")).toThrow(/prompt/);
  });
});

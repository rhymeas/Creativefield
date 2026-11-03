import {describe,expect,it} from "vitest";
import {nativeFixtureFor,nativeFixtureInputs,nativeFixtureVariants} from "../src/workflow/native-fixtures";
import {readFileSync} from "node:fs";
import {compileLocal} from "../src/capabilities/compile";
import type {CapabilityBundle} from "../src/capabilities/types";

describe("native validation fixtures",()=>{
  it("selects a workflow-specific fixture before shared port and media fixtures",()=>{
    const port={id:"source",label:"Source",type:"image" as const,required:true};
    const fixtures={"first:source":"first.png",source:"shared.png",image:"generic.png"};
    expect(nativeFixtureFor(fixtures,"first",port)).toBe("first.png");
    expect(nativeFixtureFor(fixtures,"second",port)).toBe("shared.png");
  });
  it("falls back to the physical media type and then the logical type",()=>{
    const port={id:"source",label:"Source",type:"reference" as const,representation:"video" as const,required:true};
    expect(nativeFixtureFor({video:"clip.mp4",reference:"reference.png"},"workflow",port)).toBe("clip.mp4");
    expect(nativeFixtureFor({reference:"reference.png"},"workflow",port)).toBe("reference.png");
  });
  it("supplies optional references only when a matching fixture exists",()=>{
    const ports=[{id:"source",label:"Source",type:"image" as const,required:true},{id:"reference",label:"Reference",type:"image" as const,required:false}];
    expect(nativeFixtureInputs({source:"comfyfield-source.png",reference:"comfyfield-ref.png"},"edit",ports)).toEqual({source:"comfyfield-source.png",reference:"comfyfield-ref.png"});
    expect(nativeFixtureInputs({source:"comfyfield-source.png"},"edit",ports)).toEqual({source:"comfyfield-source.png"});
  });
  it("checks default and optional inputs independently",()=>{
    const ports=[{id:"source",label:"Source",type:"image" as const,required:true},{id:"reference",label:"Reference",type:"image" as const,required:false}];
    expect(nativeFixtureVariants({source:"source.png",reference:"ref.png"},"edit",ports)).toEqual([{id:"edit",inputs:{source:"source.png"}},{id:"edit#optional-reference",inputs:{source:"source.png",reference:"ref.png"}}]);
    expect(nativeFixtureVariants({source:"source.png"},"edit",ports)).toEqual([{id:"edit",inputs:{source:"source.png"}}]);
  });
  it("checks individual optional references and their combination",()=>{
    const ports=[{id:"source",label:"Source",type:"image" as const,required:true},{id:"ref2",label:"Reference 2",type:"image" as const,required:false},{id:"ref3",label:"Reference 3",type:"image" as const,required:false}];
    expect(nativeFixtureVariants({source:"source.png",ref2:"two.png",ref3:"three.png"},"edit",ports)).toEqual([
      {id:"edit",inputs:{source:"source.png"}},
      {id:"edit#optional-ref2",inputs:{source:"source.png",ref2:"two.png"}},
      {id:"edit#optional-ref3",inputs:{source:"source.png",ref3:"three.png"}},
      {id:"edit#optional-ref2+ref3",inputs:{source:"source.png",ref2:"two.png",ref3:"three.png"}},
    ]);
  });
  it("reports an excessive variant count instead of pretending coverage is complete",()=>{
    const ports=Array.from({length:9},(_,index)=>({id:`ref${index}`,label:`Reference ${index}`,type:"image" as const,required:false}));
    expect(()=>nativeFixtureVariants({image:"example.png"},"edit",ports)).toThrow("Too many optional inputs");
  });
  it("passes optional fixture references into the real Qwen edit graph",()=>{
    const bundle:CapabilityBundle={manifest:JSON.parse(readFileSync("native-workflows/qwen-image-21-edit/manifest.json","utf8")),template:JSON.parse(readFileSync("native-workflows/qwen-image-21-edit/template.api.json","utf8"))};
    const inputs=nativeFixtureInputs({source_image:"comfyfield-source.png",reference_image:"comfyfield-front.png",reference_image_2:"comfyfield-side.png"},bundle.manifest.id,bundle.manifest.inputs);
    const graph=compileLocal(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs,controls:{},audioPolicy:"mute"});
    expect(graph["476"].inputs.image).toBe("comfyfield-side.png");
    expect(graph["459:474"].inputs["images.image_3"]).toEqual(["476",0]);
    expect(graph["477"]).toBeUndefined();
  });
  it("compiles each available Qwen reference combination independently",()=>{
    const bundle:CapabilityBundle={manifest:JSON.parse(readFileSync("native-workflows/qwen-image-21-edit/manifest.json","utf8")),template:JSON.parse(readFileSync("native-workflows/qwen-image-21-edit/template.api.json","utf8"))};
    const variants=nativeFixtureVariants({source_image:"comfyfield-source.png",reference_image:"comfyfield-required.png",reference_image_2:"comfyfield-front.png",reference_image_3:"comfyfield-side.png"},bundle.manifest.id,bundle.manifest.inputs);
    expect(variants).toHaveLength(4);
    for(const {inputs} of variants)expect(()=>compileLocal(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs,controls:{},audioPolicy:"mute"})).not.toThrow();
  });
});

import {readFileSync} from "node:fs";
import {describe,it,expect} from "vitest";
import {compileLocal} from "../src/capabilities/compile";
import {validateCapability} from "../src/capabilities/validate";
import type {CapabilityBundle,Invocation} from "../src/capabilities/types";

const pack=():CapabilityBundle=>({manifest:JSON.parse(readFileSync("native-workflows/qwen-image-21-edit/manifest.json","utf8")),template:JSON.parse(readFileSync("native-workflows/qwen-image-21-edit/template.api.json","utf8"))});
const invocation=(bundle:CapabilityBundle,extra:Record<string,string>={}):Invocation=>({capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_image:"comfyfield-source.png",reference_image:"comfyfield-front.png",...extra},controls:{prompt:"Place the same fictional character in the scene."},audioPolicy:"mute"});

describe("optional Qwen reference images",()=>{
  it("omits empty loaders and autogrow sockets without changing the original pack",()=>{
    const bundle=pack(),graph=compileLocal(bundle,invocation(bundle));
    expect(validateCapability(bundle)).toEqual([]);
    expect(graph["476"]).toBeUndefined();expect(graph["477"]).toBeUndefined();
    expect(graph["459:474"].inputs["images.image_3"]).toBeUndefined();
    expect(graph["459:474"].inputs["images.image_4"]).toBeUndefined();
    expect(graph["470"].inputs.image).toBe("comfyfield-source.png");
    expect(graph["475"].inputs.image).toBe("comfyfield-front.png");
    expect(bundle.template!["476"]).toBeDefined();
  });
  it("binds all selected images in order and supports a missing middle reference",()=>{
    const bundle=pack(),graph=compileLocal(bundle,invocation(bundle,{reference_image_2:"comfyfield-side.png",reference_image_3:"comfyfield-back.png"}));
    expect(graph["476"].inputs.image).toBe("comfyfield-side.png");expect(graph["477"].inputs.image).toBe("comfyfield-back.png");
    expect(graph["459:474"].inputs["images.image_3"]).toEqual(["476",0]);
    expect(graph["459:474"].inputs["images.image_4"]).toEqual(["477",0]);
    const sparse=compileLocal(bundle,invocation(bundle,{reference_image_3:"comfyfield-back.png"}));
    expect(sparse["476"]).toBeUndefined();expect(sparse["477"].inputs.image).toBe("comfyfield-back.png");
  });
  it("rejects untrusted paths, required omission and a reference with nonoptional consumers",()=>{
    const bundle=pack();expect(()=>compileLocal(bundle,invocation(bundle,{reference_image_2:["C:", "/fixture/untrusted"].join("")}))).toThrow("resolved by the server");
    bundle.manifest.inputs[2].required=true;expect(validateCapability(bundle).join()).toContain("Invalid optional reference");
    expect(()=>compileLocal(bundle,invocation(bundle))).toThrow("Invalid optional reference");
    const shared=pack();shared.template!["461"].inputs.images=["476",0];
    expect(validateCapability(shared).join()).toContain("Invalid optional reference consumer");
    expect(()=>compileLocal(shared,invocation(shared))).toThrow("Invalid optional reference consumer");
  });
});

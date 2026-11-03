import {describe,expect,it} from "vitest";
import {loadServerCatalogue} from "../server/catalogue";
import {compileLocal} from "../src/capabilities/compile";
import {capabilitySurface} from "../src/capabilities/surfaces";
import {modelFamily} from "../server/gpu-lane";

describe("Qwen masked canvas workflow",()=>{
  it("aligns the generated image to the source dimensions and composites the actual mask",async()=>{
    const bundle=(await loadServerCatalogue()).find(item=>item.manifest.id==="qwen-image-21-masked-edit");
    expect(bundle).toBeDefined();
    const graph=bundle!.template!;
    expect(capabilitySurface(bundle!.manifest)).toBe("canvas");
    const qwen=(await loadServerCatalogue()).find(item=>item.manifest.id==="qwen-image-21-edit")!;
    expect(modelFamily(bundle!.manifest)).toBe(modelFamily(qwen.manifest));
    expect(graph["483"].inputs).toMatchObject({image:["459:457",0],width:["482",0],height:["482",1],crop:"disabled"});
    expect(graph["488"].inputs.image).toEqual(["470",0]);
    expect(graph["489"].inputs.image).toEqual(["483",0]);
    expect(graph["484"].inputs).toMatchObject({generated_image:["489",0],original_image:["488",0],custom_mask:["481",0],custom_mask_mode:"replace",feather_pct:0});
    expect(graph["461"].inputs.images).toEqual(["484",0]);
    expect(()=>compileLocal(bundle!,{capabilityId:bundle!.manifest.id,version:bundle!.manifest.version,routeId:"local",inputs:{source_image:"comfyfield-source.png",reference_image:"comfyfield-guide.png",edit_mask:"comfyfield-mask.png"},controls:Object.fromEntries(bundle!.manifest.controls.map(c=>[c.id,c.default])),audioPolicy:"mute"})).not.toThrow();
  });
});

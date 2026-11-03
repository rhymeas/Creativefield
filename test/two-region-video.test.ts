import {readFileSync} from "node:fs";
import {describe,it,expect} from "vitest";
import {validateCapability} from "../src/capabilities/validate";
import {compileLocal} from "../src/capabilities/compile";
const manifest=JSON.parse(readFileSync("native-workflows/wan21-vace-two-region-edit/manifest.json","utf8")),template=JSON.parse(readFileSync("native-workflows/wan21-vace-two-region-edit/template.api.json","utf8")),bundle={manifest,template};
describe("two-region video composition qualification",()=>{
  const invocation={capabilityId:manifest.id,version:manifest.version,routeId:"local",inputs:{source_video:"comfyfield-source.mp4",edit_mask:"comfyfield-mask-one.mp4",edit_mask_2:"comfyfield-mask-two.mp4"},controls:{prompt:"blue jacket",prompt_2:"yellow backdrop"},audioPolicy:"mute" as const};
  it("loads the qualified combined route with both required mask roles",()=>{
    expect(validateCapability(bundle)).toEqual([]);expect(manifest.coverage.local).toBe("implemented");expect(manifest.routes[0].implementation).toBe("implemented");expect(compileLocal(bundle,invocation)["30"].inputs.file).toBe("comfyfield-mask-two.mp4");
  });
  it("uses the same original video for both generated branches and composites them in order",()=>{
    const graph=compileLocal(bundle,invocation,{allowExperimental:true});
    expect(graph["4"].inputs.file).toBe("comfyfield-source.mp4");expect(graph["6"].inputs.file).toBe("comfyfield-mask-one.mp4");expect(graph["30"].inputs.file).toBe("comfyfield-mask-two.mp4");expect(graph["10"].inputs.text).toBe("blue jacket");expect(graph["36"].inputs.text).toBe("yellow backdrop");
    expect(graph["14"].inputs.destination).toEqual(["5",0]);expect(graph["35"].inputs.destination).toEqual(["5",0]);expect(graph["15"].inputs.control_masks).toEqual(["8",0]);expect(graph["37"].inputs.control_masks).toEqual(["32",0]);
    expect(graph["19"].inputs).toMatchObject({destination:["5",0],source:["18",0],mask:["8",0]});expect(graph["40"].inputs).toMatchObject({destination:["19",0],source:["39",0],mask:["32",0]});expect(graph["20"].inputs).toMatchObject({images:["40",0],fps:["5",2]});expect(Object.values(graph).filter(n=>n.class_type==="SaveVideo")).toHaveLength(1);
  });
  it("rejects duplicate, missing, source or non-mask roles as additional masks",()=>{
    for(const additionalMaskInputs of [[],["edit_mask"],["source_video"],["missing"],["edit_mask_2","edit_mask_2"]])expect(validateCapability({...bundle,manifest:{...manifest,mediaContract:{...manifest.mediaContract,additionalMaskInputs}}})).toContain("Invalid additional aligned mask inputs");
  });
});

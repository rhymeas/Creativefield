import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {assertLocalGraphPolicy,APPROVED_LOCAL_CLASSES} from "../src/capabilities/policy";
import {validateCapability} from "../src/capabilities/validate";
import type {CapabilityBundle} from "../src/capabilities/types";

const nvidiaVfx:CapabilityBundle={
  manifest:JSON.parse(readFileSync("native-workflows/nvidia-vfx-upscale/manifest.json","utf8")),
  template:JSON.parse(readFileSync("native-workflows/nvidia-vfx-upscale/template.api.json","utf8")),
};
const scail2:CapabilityBundle={
  manifest:JSON.parse(readFileSync("native-workflows/scail2-character-replace/manifest.json","utf8")),
  template:JSON.parse(readFileSync("native-workflows/scail2-character-replace/template.api.json","utf8")),
};

describe("reviewed local node list",()=>{
  it("lets the NVIDIA VFX template through the local policy check",()=>{
    expect(validateCapability(nvidiaVfx)).toEqual([]);
    expect(()=>assertLocalGraphPolicy(nvidiaVfx.template!)).not.toThrow();
    expect(Object.values(nvidiaVfx.template!).map(node=>node.class_type)).toContain("RTXVideoSuperResolution");
  });

  it("still rejects a node the reviewed list does not name",()=>{
    expect(()=>assertLocalGraphPolicy({a:{class_type:"RTXTrueHDR",inputs:{}}})).toThrow("Unreviewed or forbidden node at a (RTXTrueHDR)");
  });

  it("admits the reviewed single-frame reference composition for two characters",()=>{
    // Both identities share one reference frame. Stacking separate reference views
    // with ImageBatch was replaced by the retained scene-composition workflow.
    const composition=["EmptyImage","ImageCompositeMasked","ImageCropToMask"];
    expect([...APPROVED_LOCAL_CLASSES]).toEqual(expect.arrayContaining(composition));
    expect(Object.values(scail2.template!).map(node=>node.class_type)).toEqual(expect.arrayContaining(composition));
    expect(Object.values(scail2.template!).some(node=>node.class_type==="ImageBatch")).toBe(false);
    expect(validateCapability(scail2)).toEqual([]);
    expect(()=>assertLocalGraphPolicy(scail2.template!)).not.toThrow();
    expect(()=>assertLocalGraphPolicy({a:{class_type:"NotAReviewedNode",inputs:{}}})).toThrow();
  });
  it("allows the reviewed core nodes of the official Wan video templates and nothing remote",()=>{
    for(const name of ["Wan22FunControlToVideo","WanFunInpaintToVideo","WanSoundImageToVideo","WanDancerVideo","WanMoveTrackToVideo","ImageStitch","StartLoop","EndLoop","Painter"])
      expect(()=>assertLocalGraphPolicy({a:{class_type:name,inputs:{}}}),name).not.toThrow();
    expect(()=>assertLocalGraphPolicy({a:{class_type:"WanDancerVideo",inputs:{url:"https://example.com/x"}}})).toThrow("Remote input");
    expect(()=>assertLocalGraphPolicy({a:{class_type:"ComfyApiPartnerNode",inputs:{}}})).toThrow();
  });
});

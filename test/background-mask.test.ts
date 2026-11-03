import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {compileLocal} from "../src/capabilities/compile";
import {assertLocalGraphPolicy} from "../src/capabilities/policy";
import {validateCapability} from "../src/capabilities/validate";
import type {CapabilityBundle} from "../src/capabilities/types";

const bundle:CapabilityBundle={manifest:JSON.parse(readFileSync("native-workflows/sam31-video-background-mask/manifest.json","utf8")),template:JSON.parse(readFileSync("native-workflows/sam31-video-background-mask/template.api.json","utf8"))};
describe("background tracking workflow",()=>{
  it("binds the named protected subject and inverts only the tracked-mask branch",()=>{
    expect(validateCapability(bundle)).toEqual([]);
    expect(()=>assertLocalGraphPolicy(bundle.template!)).not.toThrow();
    const graph=compileLocal(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_video:"comfyfield-source.mp4"},controls:{prompt:"the foreground person",threshold:.4},audioPolicy:"mute"});
    expect(graph["1"].inputs.file).toBe("comfyfield-source.mp4");
    expect(graph["4"].inputs.text).toBe("the foreground person");
    expect(graph["5"].inputs.detection_threshold).toBe(.4);
    expect(graph["10"]).toEqual({class_type:"InvertMask",inputs:{mask:["6",0]}});
    expect(graph["7"].inputs.mask).toEqual(["10",0]);
    expect(graph["8"].inputs.fps).toEqual(["2",2]);
    expect(bundle.manifest.outputContract).toMatchObject({kind:"source_linked_mask_v1",trackingMode:"prompt",semantics:"white_edits_black_preserves",artifactNode:"9"});
  });
  it("leaves the existing object tracking graph uninverted",()=>{
    const original=JSON.parse(readFileSync("native-workflows/sam31-video-mask/template.api.json","utf8"));
    expect(original["7"].inputs.mask).toEqual(["6",0]);
    expect(original["10"]).toBeUndefined();
  });
});

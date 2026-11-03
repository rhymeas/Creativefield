import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {buildReplaceVideoProbeGraph,VIDEO_PROBE_FRAMES,VIDEO_PROBE_INDICES} from "../src/capabilities/replace-video-probe";
import {compileLocal} from "../src/capabilities/compile";
import {validateCapability} from "../src/capabilities/validate";
import type {ApiGraph} from "../src/workflow/build";
import type {CapabilityBundle} from "../src/capabilities/types";
import {cleanSourceRule} from "../src/capabilities/clean";
const original=JSON.parse(readFileSync("native-workflows/scail2-character-replace/template.api.json","utf8")) as ApiGraph;
describe("actual video-frame probe",()=>{
  it("samples five video frames and exports two nonzero decoder frames, never reference inputs",()=>{
    const graph=structuredClone(original);graph["344"].inputs.value=true;
    const before=structuredClone(graph),result=buildReplaceVideoProbeGraph(graph);
    expect(graph).toEqual(before);
    expect(result["213:114"].inputs.length).toBe(5);
    expect(result["213:197"].inputs.object_indices).toBe("0,1");
    expect(result["352"].inputs.object_indices).toBe("0,1");
    expect(result["213:19"].inputs.latent_image).toEqual(["213:114",2]);
    expect(result["213:6"].inputs.samples).toEqual(["213:19",1]);
    for(const index of VIDEO_PROBE_INDICES){
      expect(result[`probe:save:${index}`].inputs.images).toEqual([`probe:frame:${index}`,0]);
      expect(result[`probe:frame:${index}`].inputs).toEqual({image:["213:6",0],batch_index:index,length:1});
    }
    expect(Object.values(result).filter(n=>n.class_type==="SaveImage")).toHaveLength(2);
    expect(Object.values(result).filter(n=>n.class_type==="SamplerCustom")).toHaveLength(1);
    expect(Object.values(result).some(n=>/SaveVideo|CreateVideo|Upscale/.test(n.class_type))).toBe(false);
  });
  it("bounds driving images before resizing and tracking and removes continuation state",()=>{
    const graph=structuredClone(original);graph["344"].inputs.value=true;
    graph["213:114"].inputs.previous_frames=["unused:decode",0];graph["213:114"].inputs.video_frame_offset=76;
    const result=buildReplaceVideoProbeGraph(graph);
    expect(result["213:900"].inputs.input).toEqual(["probe:source:213:157",0]);
    expect(result["probe:source:213:157"].inputs).toEqual({image:["213:157",0],batch_index:0,length:VIDEO_PROBE_FRAMES});
    expect(result["213:177"].inputs.length).toBe(5);
    expect(result["213:114"].inputs).toMatchObject({video_frame_offset:0});
    expect(result["213:114"].inputs.previous_frames).toBeUndefined();
    expect(result["unused:decode"]).toBeUndefined();
  });
  it("rejects bypassed sampling and validates the native two-reference image-output pack",()=>{
    const bad=structuredClone(original);bad["213:6"].inputs.samples=["reference-latent",0];
    expect(()=>buildReplaceVideoProbeGraph(bad)).toThrow("must come from");
    const root="native-workflows/replace-video-frame-probe",bundle={manifest:JSON.parse(readFileSync(root+"/manifest.json","utf8")),template:JSON.parse(readFileSync(root+"/template.api.json","utf8"))} as CapabilityBundle;
    expect(validateCapability(bundle)).toEqual([]);
    const g=compileLocal(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_video:"comfyfield-video.mp4",character_image:"comfyfield-left.webp",character_image_2:"comfyfield-right.jpg"},controls:{prompt:"Keep poses and reference identities."},audioPolicy:"mute"});
    expect(g["155"].inputs.file).toBe("comfyfield-video.mp4");expect(g["30"].inputs.image).toBe("comfyfield-left.webp");expect(g["330"].inputs.image).toBe("comfyfield-right.jpg");
    expect(bundle.manifest.outputs.map(o=>o.type)).toEqual(["image","image"]);
    expect(cleanSourceRule(bundle.manifest)).toEqual({sourceInput:"source_video",fps:24});
    expect(g["213:114"].inputs.length).toBe(5);
  });
  it("removes the second identity entirely for a bounded single-person control",()=>{
    const root="native-workflows/replace-video-frame-probe-single",bundle={manifest:JSON.parse(readFileSync(root+"/manifest.json","utf8")),template:JSON.parse(readFileSync(root+"/template.api.json","utf8"))} as CapabilityBundle;
    expect(validateCapability(bundle)).toEqual([]);expect(cleanSourceRule(bundle.manifest)).toEqual({sourceInput:"source_video",fps:24});
    for(const person of ["0","1"]){
      const g=compileLocal(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_video:"comfyfield-video.mp4",character_image:"comfyfield-person.webp"},controls:{prompt:"Replace only this person.",person},audioPolicy:"mute"});
      expect(g["213:197"].inputs.object_indices).toBe(person);expect(g["213:199"].inputs.object_indices).toBe("0");
      expect(g["330"]).toBeUndefined();expect(g["345"]).toBeUndefined();expect(g["352"]).toBeUndefined();
      expect(g["213:114"].inputs.length).toBe(5);expect(Object.values(g).filter(n=>n.class_type==="SaveImage")).toHaveLength(2);
      expect(g["213:114"].inputs.reference_image).toEqual(["213:225",0]);
    }
  });
});

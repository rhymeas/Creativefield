import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {validateCapability} from "../src/capabilities/validate";
import {compileLocal} from "../src/capabilities/compile";
import type {CapabilityBundle} from "../src/capabilities/types";
import {sceneAnchorPrompt} from "../src/capabilities/scene-anchor";
import {sceneAnchorOrder} from "../src/team/scene-anchor-order";
import {sceneAnchorDraft,sceneAnchorKey,videoProbeDraft,videoProbeKey,videoProbeContext} from "../src/team/scene-anchor-state";
const root="native-workflows/replace-scene-anchor",bundle={manifest:JSON.parse(readFileSync(root+"/manifest.json","utf8")),template:JSON.parse(readFileSync(root+"/template.api.json","utf8"))} as CapabilityBundle;
describe("static scene frame with intact character references",()=>{
  it("keeps raw-reference receipt contexts and separates legacy scene-mode results",()=>{
    const raw={video:"clip",references:["left","right"],prompt:"",worker:"worker"};
    expect(videoProbeContext(raw)).toBe(JSON.stringify(raw));
    const legacy={...raw,sceneImageId:"scene"},current=videoProbeContext(legacy);
    expect(current).not.toBe(JSON.stringify(legacy));expect(JSON.parse(current)).toMatchObject({sceneImageId:"scene",sceneMode:"animation"});
  });
  it("validates and binds all three images directly, with no reference masks or video output",()=>{
    expect(validateCapability(bundle)).toEqual([]);
    const graph=compileLocal(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_image:"comfyfield-frame.png",reference_image:"comfyfield-left.webp",reference_image_2:"comfyfield-right.jpg"},controls:{prompt:sceneAnchorPrompt()},audioPolicy:"mute"});
    const encode=Object.values(graph).find(n=>n.class_type==="TextEncodeQwenImage21")!;
    expect(encode.inputs["images.image_1"]).toEqual(["470",0]);
    expect(encode.inputs["images.image_2"]).toEqual(["475",0]);
    expect(encode.inputs["images.image_3"]).toEqual(["476",0]);
    expect(encode.inputs["images.image_4"]).toBeUndefined();
    expect(Object.values(graph).some(n=>/SAM|Mask|Crop|Video/.test(n.class_type))).toBe(false);
    expect(bundle.manifest.outputs.every(p=>p.type==="image")).toBe(true);
    expect(Object.values(graph).find(n=>n.class_type==="SaveImageAdvanced")?.inputs.filename_prefix).toBe("ras/scene-anchor");
  });
  it("requires both reference images and asks for scene/pose preservation and clean output",()=>{
    expect(bundle.manifest.inputs.every(p=>p.required)).toBe(true);
    expect(sceneAnchorPrompt()).toContain("exact body, hand and head poses");
    expect(sceneAnchorPrompt()).toContain("Remove all social media interface overlays");
  });
  it("keeps the experimental Flux variant image-only with two intact references and source-sized output",()=>{
    const path="native-workflows/replace-scene-anchor-flux",flux={manifest:JSON.parse(readFileSync(path+"/manifest.json","utf8")),template:JSON.parse(readFileSync(path+"/template.api.json","utf8"))} as CapabilityBundle;
    expect(validateCapability(flux)).toEqual([]);
    const g=compileLocal(flux,{capabilityId:flux.manifest.id,version:flux.manifest.version,routeId:"local",inputs:{source_image:"comfyfield-frame.png",reference_image:"comfyfield-left.webp",reference_image_2:"comfyfield-right.jpg"},controls:{prompt:"Keep the source poses."},audioPolicy:"mute"});
    expect(g["3"].inputs.image).toEqual(["4",0]);
    // Fibo 2.0 (since 2026-10-31): the frame, then the two references, in that order on the encoder's image sockets.
    expect(g["11"].inputs).toMatchObject({"images.image_1":["7",0],"images.image_2":["5",0],"images.image_3":["6",0]});
    expect(g["27"].inputs["resize_type.match"]).toEqual(["3",0]);
    expect(Object.values(g).some(n=>/SAM|Inpaint|Crop|Video|TrackToMask/.test(n.class_type))).toBe(false);
    expect(g["28"].inputs.filename_prefix).toBe("ras/scene-anchor-flux");
  });
  it("orders the two unmodified references by target person rather than upload order",()=>{
    const result=sceneAnchorOrder([{asset:"a",index:0},{asset:"b",index:1}],"Replace the person on the right with @Image 1. Replace the person on the left with @Image 2.",true);
    expect(result.references).toEqual(["b","a"]);expect(result.problem).toBe("");expect(result.prompt).toBe("");
    expect(sceneAnchorOrder([{asset:"a",index:0},{asset:"b",index:0}],"",false).problem).not.toBe("");
  });
  it("restores the scene selection on reload without inventing or resubmitting a run",()=>{
    const video="806b049c-d969-408a-a19c-4c5cf600286c",references=["20cd38af-1b55-4dce-96ec-73112ea3bbbd","c8b8a155-cb8c-4dfe-b604-9381adeeaff4"];
    const storage={getItem:(key:string)=>key===sceneAnchorKey("ws","project")?JSON.stringify({context:JSON.stringify({video,references,prompt:"Keep the microphone",worker:"local"}),runId:"existing-run"}):null};
    expect(sceneAnchorDraft(storage,"ws","project","local")).toEqual({video,faces:references.map((asset,index)=>({asset,index})),prompt:"Keep the microphone"});
    expect(sceneAnchorDraft(storage,"ws","other-project","local")).toBeNull();
    expect(sceneAnchorDraft(storage,"ws","project","other-worker")).toBeNull();
    expect(sceneAnchorDraft({getItem:()=>"broken"},"ws","project","local")).toBeNull();
    const probeStorage={getItem:(key:string)=>key===videoProbeKey("ws","project")?storage.getItem(sceneAnchorKey("ws","project")):null};
    expect(videoProbeDraft(probeStorage,"ws","project","local")).toEqual(sceneAnchorDraft(storage,"ws","project","local"));
    expect(sceneAnchorDraft(probeStorage,"ws","project","local")).toBeNull();
    const single={getItem:()=>JSON.stringify({context:JSON.stringify({video,references:[references[0]],prompt:"",worker:"local",personIndex:1})})};
    expect(videoProbeDraft(single,"ws","project","local")?.faces).toEqual([{asset:references[0],index:1}]);
    expect(sceneAnchorDraft(single,"ws","project","local")).toBeNull();
    const sceneId="d7ff3775-9924-457c-87d5-3d3fa64dcbd4",sceneProbe={getItem:()=>JSON.stringify({context:JSON.stringify({video,references,prompt:"",worker:"local",sceneImageId:sceneId})})};
    expect(videoProbeDraft(sceneProbe,"ws","project","local")?.sceneImageId).toBe(sceneId);
    expect(videoProbeDraft({getItem:()=>JSON.stringify({context:JSON.stringify({video,references,prompt:"",worker:"local",sceneImageId:"invalid"})})},"ws","project","local")).toBeNull();
  });
});

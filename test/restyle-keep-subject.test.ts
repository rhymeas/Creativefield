import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {compileLocal} from "../src/capabilities/compile";
import {KEEP_SOURCE_SUBJECT,keepSourceSubjectPrompt} from "../src/capabilities/keep-subject";
import {assertLocalGraphPolicy} from "../src/capabilities/policy";
import {validateCapability} from "../src/capabilities/validate";
import type {CapabilityBundle,Invocation} from "../src/capabilities/types";

function loadPack(id:string):CapabilityBundle{
  const root=`native-workflows/${id}`;
  return {manifest:JSON.parse(readFileSync(`${root}/manifest.json`,"utf8")),template:JSON.parse(readFileSync(`${root}/template.api.json`,"utf8"))} as CapabilityBundle;
}

const canny=loadPack("vace-canny-restyle"),reference=loadPack("vace-reference-restyle"),depth=loadPack("vace-depth-restyle");

function invocationOf(bundle:CapabilityBundle,overrides:Partial<Invocation>={}):Invocation{
  return {capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_video:"comfyfield-source.mp4"},controls:{},audioPolicy:"mute",...overrides};
}

describe("restyle keeps the person from the clip",()=>{
  it("hands VACE the clip's own first frame as the reference image",()=>{
    expect(validateCapability(canny)).toEqual([]);
    expect(canny.manifest.subjectContract).toEqual({kind:"keep_source_subject_v1"});
    const graph=canny.template!;
    // The first fitted frame, not a caller image: the person comes from the clip itself.
    expect(graph["19"]).toMatchObject({class_type:"ImageFromBatch",inputs:{image:["16",0],batch_index:0,length:1}});
    expect(graph["10"].inputs.reference_image).toEqual(["19",0]);
    expect(graph["10"].inputs.control_video).toEqual(["6",0]);
    // Reference conditioning prepends two frames, so the clip starts on the generated scene.
    expect(graph["20"]).toMatchObject({class_type:"ImageFromBatch",inputs:{image:["13",0],batch_index:2,length:["7",2]}});
    expect(graph["14"].inputs.images).toEqual(["20",0]);
    expect(graph["14"].inputs.fps).toEqual(["5",2]);
    assertLocalGraphPolicy(graph);
  });

  it("keeps the source length and rate after the reference trim",()=>{
    const graph=compileLocal(canny,invocationOf(canny,{controls:{prompt:"a stone cottage by the sea"}}));
    // Width, height and length all still come from the fitted source frames.
    expect(graph["7"].inputs.image).toEqual(["16",0]);
    expect(graph["20"].inputs.length).toEqual(["7",2]);
    expect(graph["14"].inputs.fps).toEqual(["5",2]);
    expect(graph["19"].inputs.image).toEqual(["16",0]);
  });

  it("adds the keep-the-subject clause after the person's own words",()=>{
    const graph=compileLocal(canny,invocationOf(canny,{controls:{prompt:"imagine this gentleman standing in his grandpa livingroom"}}));
    expect(graph["8"].inputs.text).toBe(`imagine this gentleman standing in his grandpa livingroom\n\n${KEEP_SOURCE_SUBJECT}`);
    expect(KEEP_SOURCE_SUBJECT).toMatch(/same person/);
    expect(KEEP_SOURCE_SUBJECT).toMatch(/same face, same hair, same clothes and same pose/);
    expect(keepSourceSubjectPrompt("  ")).toBe(KEEP_SOURCE_SUBJECT);
    expect(keepSourceSubjectPrompt(" a red barn ")).toBe(`a red barn\n\n${KEEP_SOURCE_SUBJECT}`);
  });

  it("wraps the other edge looks only where the manifest asks for it",()=>{
    expect(reference.manifest.subjectContract).toBeUndefined();
    expect(depth.manifest.subjectContract).toBeUndefined();
    const styled=compileLocal(reference,invocationOf(reference,{inputs:{source_video:"comfyfield-source.mp4",style_reference:"comfyfield-style.png"},controls:{prompt:"Keep the walk"}}));
    expect(styled["8"].inputs.text).toBe("Keep the walk");
  });

  it("refuses a keep-subject contract with no prompt text control",()=>{
    const broken=structuredClone(canny);
    broken.manifest.subjectContract={kind:"keep_source_subject_v1"};
    broken.manifest.controls.find(control=>control.id==="prompt")!.binding={node:"6",field:"low_threshold"};
    expect(validateCapability(broken).join(" ")).toContain("Invalid keep-subject prompt control");
    const wrongKind=structuredClone(canny);
    (wrongKind.manifest.subjectContract as {kind:string}).kind="keep_anything";
    expect(validateCapability(wrongKind).join(" ")).toContain("Invalid keep-subject prompt contract");
  });
});

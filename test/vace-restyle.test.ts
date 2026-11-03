import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {compileLocal} from "../src/capabilities/compile";
import {KEEP_SOURCE_SUBJECT} from "../src/capabilities/keep-subject";
import {assertLocalGraphPolicy} from "../src/capabilities/policy";
import {validateCapability} from "../src/capabilities/validate";
import type {CapabilityBundle,Invocation} from "../src/capabilities/types";
import {defaultDraft,draftErrors} from "../src/team/state";

function loadPack(id:string):CapabilityBundle{
  const root=`native-workflows/${id}`;
  return {manifest:JSON.parse(readFileSync(`${root}/manifest.json`,"utf8")),template:JSON.parse(readFileSync(`${root}/template.api.json`,"utf8"))} as CapabilityBundle;
}

const reference=loadPack("vace-reference-restyle"),canny=loadPack("vace-canny-restyle"),restyle14b=loadPack("vace-canny-restyle-14b"),maskedReference=loadPack("wan21-vace-masked-edit-reference");

function invocationOf(bundle:CapabilityBundle,overrides:Partial<Invocation>={}):Invocation{
  return {capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_video:"comfyfield-source.mp4"},controls:{},audioPolicy:"mute",...overrides};
}

describe("VACE reference restyle",()=>{
  it("loads a reviewed graph that keeps the source timing",()=>{
    expect(validateCapability(reference)).toEqual([]);
    expect(reference.template!["16"]?.class_type).toBe("LoadImage");
    expect(reference.template!["6"]?.class_type).toBe("Canny");
    expect(reference.template!["10"]?.class_type).toBe("WanVaceToVideo");
    expect(reference.manifest.inputs).toEqual([
      expect.objectContaining({id:"source_video",type:"video",required:true,binding:{node:"4",field:"file"}}),
      expect.objectContaining({id:"style_reference",type:"image",required:true,binding:{node:"16",field:"image"}}),
    ]);
    expect(reference.manifest.audioPolicies).toEqual(["mute"]);
    assertLocalGraphPolicy(reference.template!);
  });

  it("feeds the reference image into VACE reference conditioning, not into the control video",()=>{
    const graph=compileLocal(reference,invocationOf(reference,{inputs:{source_video:"comfyfield-source.mp4",style_reference:"comfyfield-style.png"},controls:{prompt:"Keep the walk, paint the street like the reference"}}));
    expect(graph["4"].inputs.file).toBe("comfyfield-source.mp4");
    expect(graph["16"].inputs.image).toBe("comfyfield-style.png");
    expect(graph["10"].inputs.reference_image).toEqual(["16",0]);
    expect(graph["10"].inputs.control_video).toEqual(["6",0]);
    // VACE reference conditioning emits the reference as frame 0; trim it so the
    // clip starts on the generated performance.
    expect(graph["17"].inputs.image).toEqual(["13",0]);
    expect(graph["17"].inputs.batch_index).toBe(2);
    expect(graph["14"].inputs.images).toEqual(["17",0]);
    expect(graph["8"].inputs.text).toBe("Keep the walk, paint the street like the reference");
    assertLocalGraphPolicy(graph);
  });

  it("refuses a run without the style reference",()=>{
    expect(()=>compileLocal(reference,invocationOf(reference))).toThrow("Missing asset: style_reference");
  });

  it("fits the source to Wan VACE before Canny, with the same limits as the other looks",()=>{
    const graph=reference.template!;
    // First 81 frames, then about 0.4 MP, then sides divisible by 16 — the Canny look order.
    expect(graph["18"]).toMatchObject({class_type:"ImageFromBatch",inputs:{image:["5",0],batch_index:0,length:81}});
    expect(graph["19"]).toMatchObject({class_type:"ResizeImageMaskNode",inputs:{input:["18",0],resize_type:"scale total pixels","resize_type.megapixels":0.4}});
    expect(graph["20"]).toMatchObject({class_type:"ResizeImageMaskNode",inputs:{input:["19",0],resize_type:"scale to multiple","resize_type.multiple":16}});
    expect(graph["6"].inputs.image).toEqual(["20",0]);
    expect(graph["7"].inputs.image).toEqual(["20",0]);
    // The length is the fitted count, so the head trim and the source fps stay as they were.
    expect(graph["17"]).toMatchObject({class_type:"ImageFromBatch",inputs:{image:["13",0],batch_index:2,length:["7",2]}});
    expect(graph["14"].inputs.fps).toEqual(["5",2]);
    expect(reference.manifest.version).toBe("0.3.0");
    const required=reference.manifest.routes[0].requirements.map(requirement=>requirement.name);
    expect(required).toEqual(expect.arrayContaining(["ImageFromBatch","ResizeImageMaskNode"]));
    expect(graph["10"].inputs.reference_image).toEqual(["16",0]);
    expect(graph["10"].inputs.control_video).toEqual(["6",0]);
    assertLocalGraphPolicy(graph);
  });
});

describe("masked edit with a reference",()=>{
  it("keeps the aligned source/mask envelope and adds reference conditioning",()=>{
    expect(validateCapability(maskedReference)).toEqual([]);
    expect(maskedReference.manifest.mediaContract).toEqual({kind:"aligned_video_mask_v1",sourceInput:"source_video",maskInput:"edit_mask"});
    expect(maskedReference.manifest.audioPolicies).toEqual(["mute"]);
    expect(maskedReference.manifest.inputs.map(port=>port.id)).toEqual(["source_video","edit_mask","object_reference"]);
    const graph=compileLocal(maskedReference,invocationOf(maskedReference,{inputs:{source_video:"comfyfield-source.mp4",edit_mask:"comfyfield-mask.mp4",object_reference:"comfyfield-jacket.png"},controls:{prompt:"A deep purple velvet bomber jacket"}}));
    expect(graph["22"].inputs.image).toBe("comfyfield-jacket.png");
    expect(graph["15"].inputs.reference_image).toEqual(["22",0]);
    // A mask input beside reference conditioning left the clip unedited in ComfyUI 0.37.0,
    // so the render is full-frame and the composite below keeps the change inside the mask.
    expect(graph["15"].inputs.control_masks).toBeUndefined();
    expect(graph["15"].inputs.control_video).toEqual(["14",0]);
    expect(graph["23"]).toMatchObject({class_type:"ImageFromBatch",inputs:{image:["18",0],batch_index:2,length:["9",2]}});
    expect(graph["19"].inputs.source).toEqual(["23",0]);
    expect(maskedReference.manifest.version).toBe("0.2.0");
    assertLocalGraphPolicy(graph);
  });

  it("refuses a masked reference run without the reference image",()=>{
    expect(()=>compileLocal(maskedReference,invocationOf(maskedReference,{inputs:{source_video:"comfyfield-source.mp4",edit_mask:"comfyfield-mask.mp4"}}))).toThrow("Missing asset: object_reference");
  });
});

describe("VACE 14B restyle",()=>{
  it("stays experimental after the corrupted 14B output and still compiles for re-qualification",()=>{
    expect(validateCapability(restyle14b)).toEqual([]);
    expect(restyle14b.manifest.coverage.local).toBe("experimental");
    expect(restyle14b.manifest.routes[0].evidence.join(" ")).toContain("no recognisable subject");
    expect(restyle14b.manifest.presets.map(preset=>preset.id)).toEqual(["noir","golden-hour","neon-night","hand-painted"]);
    const graph=compileLocal(restyle14b,invocationOf(restyle14b,{controls:{prompt:""},presetId:"noir"}),{allowExperimental:true});
    expect(graph["1"].inputs.unet_name).toBe("wan2.1_vace_14B_fp8_e4m3fn_local.safetensors");
    expect(graph["15"].inputs.filename_prefix).toContain("14b");
    expect(graph["8"].inputs.text).toMatch(/^Black-and-white film noir/);
    assertLocalGraphPolicy(graph);
  });
});

describe("restyle looks",()=>{  it("fills the prompt from the chosen look and keeps the user's note",()=>{
    const onlyPreset=compileLocal(canny,invocationOf(canny,{controls:{prompt:""},presetId:"noir"}));
    expect(onlyPreset["8"].inputs.text).toMatch(/^Black-and-white film noir/);
    const withNote=compileLocal(canny,invocationOf(canny,{controls:{prompt:"A woman walking past a shop window"},presetId:"noir"}));
    expect(withNote["8"].inputs.text).toBe(`Black-and-white film noir, hard directional key light, deep shadows, soft haze, 1950s cinematography.\n\nA woman walking past a shop window\n\n${KEEP_SOURCE_SUBJECT}`);
  });

  it("rejects a look that is not part of the workflow",()=>{
    expect(()=>compileLocal(canny,invocationOf(canny,{controls:{prompt:"x"},presetId:"unknown"}))).toThrow("Selected preset is not part of this workflow");
  });

  it("lets an empty prompt pass only when the look supplies one",()=>{
    const draft={...defaultDraft(canny.manifest),presetId:"noir"};
    expect(draftErrors(canny.manifest,draft)).toEqual([]);
    const empty={...defaultDraft(canny.manifest),controls:{...defaultDraft(canny.manifest).controls,prompt:""}};
    expect(draftErrors(canny.manifest,empty).join(" ")).toContain("enter valid text");
  });

  it("offers four implemented looks",()=>{
    expect(canny.manifest.presets.map(preset=>preset.id)).toEqual(["noir","golden-hour","neon-night","hand-painted"]);
    for(const preset of canny.manifest.presets)expect(String(preset.values.prompt).length).toBeGreaterThan(30);
  });
});

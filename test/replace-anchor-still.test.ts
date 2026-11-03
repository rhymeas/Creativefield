import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {anchorStillPrompt,compileAnchorStill} from "../src/capabilities/anchor-still";
import {compileRunGraph} from "../server/execution";
import {assertLocalGraphPolicy} from "../src/capabilities/policy";
import type {CapabilityBundle} from "../src/capabilities/types";
import {validateCapability} from "../src/capabilities/validate";

const root="native-workflows/replace-anchor-still";
const bundle:CapabilityBundle={
  manifest:JSON.parse(readFileSync(`${root}/manifest.json`,"utf8")),
  template:JSON.parse(readFileSync(`${root}/template.api.json`,"utf8")),
};

function run(inputs:Record<string,string>,controls:Record<string,unknown>={}){
  return compileAnchorStill(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs,controls,audioPolicy:"mute"});
}

describe("replace-anchor-still pack",()=>{
  it("is a valid local pack with one still output",()=>{
    expect(validateCapability(bundle)).toEqual([]);
    assertLocalGraphPolicy(bundle.template!);
    expect(bundle.manifest.outputs).toEqual([expect.objectContaining({type:"image",required:true})]);
    expect(bundle.manifest.coverage.local).toBe("implemented");
    expect(bundle.manifest.routes).toEqual([expect.objectContaining({id:"local",execution:"local_comfy",provider:"comfy-local",implementation:"implemented"})]);
    expect(bundle.manifest.audioPolicies).toEqual(["mute"]);
  });

  it("binds the clip, both pictures, the extra words and the frame",()=>{
    const byId=Object.fromEntries(bundle.manifest.inputs.map(port=>[port.id,port]));
    expect(byId.source_video).toMatchObject({type:"video",required:false,binding:{node:"1",field:"file"}});
    expect(byId.source_image).toMatchObject({type:"image",required:false,binding:{node:"4",field:"image"}});
    expect(byId.character_image).toMatchObject({required:true,binding:{node:"5",field:"image"}});
    expect(byId.character_image_2).toMatchObject({required:false,binding:{node:"6",field:"image"}});
    expect(bundle.manifest.controls).toEqual([
      expect.objectContaining({id:"prompt",default:"",binding:{node:"11",field:"prompt"}}),
      expect.objectContaining({id:"frame",default:0,binding:{node:"3",field:"batch_index"}}),
    ]);
  });

  it("reads the chosen frame from the clip and leaves the still input out",()=>{
    const graph=run({source_video:"comfyfield-clip.mp4",character_image:"comfyfield-face.png",character_image_2:"comfyfield-second.png"},{frame:12,prompt:"Keep the sunglasses off."});
    expect(graph["1"].inputs.file).toBe("comfyfield-clip.mp4");
    expect(graph["3"].inputs.image).toEqual(["2",0]);
    expect(graph["3"].inputs.batch_index).toBe(12);
    expect(graph["4"]).toBeUndefined();
    expect(graph["11"].inputs.prompt).toBe(`${anchorStillPrompt(true)}\n\nKeep the sunglasses off.`);
    expect(graph["11"].inputs.prompt).toContain("the person in the third picture");
  });

  it("uses a prepared still in place of the clip's first frame",()=>{
    const graph=run({source_image:"comfyfield-frame.png",character_image:"comfyfield-face.png"});
    expect(graph["1"]).toBeUndefined();
    expect(graph["2"]).toBeUndefined();
    expect(graph["3"].inputs.image).toEqual(["4",0]);
    expect(graph["3"].inputs.batch_index).toBe(0);
    expect(()=>run({source_image:"comfyfield-frame.png",character_image:"comfyfield-face.png"},{frame:3})).toThrow("only frame 0");
  });

  it("refuses a run without a clip or a still",()=>{
    expect(()=>run({character_image:"comfyfield-face.png"})).toThrow("Choose a clip or a still frame");
  });

  it("leaves the second picture's branch out when there is one person",()=>{
    const graph=run({source_video:"comfyfield-clip.mp4",character_image:"comfyfield-face.png"});
    expect(graph["6"]).toBeUndefined();
    expect(graph["11"].inputs["images.image_3"]).toBeUndefined();
    expect(graph["11"].inputs["images.image_2"]).toEqual(["5",0]);
    expect(graph["11"].inputs.prompt).toContain("the person in the second picture");
    expect(graph["11"].inputs.prompt).not.toContain("third picture");
    expect(graph["11"].inputs.prompt).not.toContain("both people");
  });

  it("uses the anchor compiler in the server execution path with uploaded filenames",()=>{
    const invocation={capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_video:"asset-id",character_image:"other-id"},controls:{},audioPolicy:"mute" as const};
    const graph=compileRunGraph(bundle,invocation,{source_video:"comfyfield-clip.mp4",character_image:"comfyfield-face.png"});
    expect(graph["1"].inputs.file).toBe("comfyfield-clip.mp4");
    expect(graph["5"].inputs.image).toBe("comfyfield-face.png");
    expect(graph["6"]).toBeUndefined();
    expect(graph["4"]).toBeUndefined();
  });

  it("chains the frame and both pictures as references in that order",()=>{
    const graph=run({source_video:"comfyfield-clip.mp4",character_image:"comfyfield-face.png",character_image_2:"comfyfield-second.png"});
    expect(graph["11"].class_type).toBe("TextEncodeFibo2");
    expect(graph["11"].inputs).toMatchObject({"images.image_1":["7",0],"images.image_2":["5",0],"images.image_3":["6",0]});
    expect(graph["25"].inputs).toMatchObject({positive:["11",0],negative:["11",1],latent_image:["11",2],cfg:1});
    expect(graph["27"].inputs["resize_type.match"]).toEqual(["3",0]);
  });
});

import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {compileFromStill,fromStillMotion,fromStillScene,fromStillWindowFrames} from "../src/capabilities/from-still";
import {assertLocalGraphPolicy} from "../src/capabilities/policy";
import type {CapabilityBundle} from "../src/capabilities/types";
import {validateCapability} from "../src/capabilities/validate";

const root="native-workflows/replace-from-still";
const bundle:CapabilityBundle={
  manifest:JSON.parse(readFileSync(`${root}/manifest.json`,"utf8")),
  template:JSON.parse(readFileSync(`${root}/template.api.json`,"utf8")),
};

function run(inputs:Record<string,string>,controls:Record<string,unknown>={},frames?:number){
  return compileFromStill(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs,controls,audioPolicy:"mute"},{frames});
}

const assets={source_video:"comfyfield-clip.mp4",anchor_image:"comfyfield-anchor.png"};

describe("replace-from-still pack",()=>{
  it("is a valid local pack with one video output",()=>{
    expect(validateCapability(bundle)).toEqual([]);
    assertLocalGraphPolicy(bundle.template!);
    expect(bundle.manifest.outputs).toEqual([expect.objectContaining({type:"video",required:true})]);
    expect(bundle.manifest.routes).toEqual([expect.objectContaining({id:"local",execution:"local_comfy",provider:"comfy-local"})]);
    expect(bundle.manifest.audioPolicies).toEqual(["mute"]);
  });

  it("takes the clean clip and the approved still",()=>{
    const byId=Object.fromEntries(bundle.manifest.inputs.map(port=>[port.id,port]));
    expect(byId.source_video).toMatchObject({type:"video",required:true,binding:{node:"1",field:"file"}});
    expect(byId.anchor_image).toMatchObject({type:"image",required:true,binding:{node:"anchor",field:"image"}});
    expect(Object.keys(byId)).toEqual(["source_video","anchor_image"]);
    expect(bundle.manifest.controls.map(control=>control.id)).toEqual(["prompt","pose_prompt"]);
  });

  it("binds the clip and the still into the reviewed graph",()=>{
    const graph=run(assets);
    expect(graph["1"].inputs.file).toBe("comfyfield-clip.mp4");
    expect(graph["anchor"].inputs.image).toBe("comfyfield-anchor.png");
  });

  it("poses each person on their own mask and draws both on one canvas",()=>{
    const graph=run(assets);
    expect(graph["maskL"].inputs.object_indices).not.toBe(graph["maskR"].inputs.object_indices);
    expect(graph["kpL"].inputs.image).toEqual(["isoL",0]);
    expect(graph["kpR"].inputs.image).toEqual(["isoR",0]);
    expect(graph["isoL"].inputs).toMatchObject({source:["sourceSlice",0],mask:["maskBackL",0]});
    expect(graph["isoR"].inputs).toMatchObject({source:["sourceSlice",0],mask:["maskBackR",0]});
    expect(graph["poseBoth"].inputs.destination).toEqual(["poseL",0]);
    expect(graph["poseBoth"].inputs.mask).toEqual(["maskBackR",0]);
    expect(graph["261:243"].inputs.input).toEqual(["poseBoth",0]);
    expect(graph["261:244"].inputs.input).toEqual(["anchorFit",0]);
  });

  it("composites the render over the clean clip through the person mask",()=>{
    const graph=run(assets);
    expect(graph["compose"].inputs.destination).toEqual(["sourceSlice",0]);
    expect(graph["compose"].inputs.source).toEqual(["crop",0]);
    expect(graph["compose"].inputs.mask).toEqual(["maskSliceBack",0]);
    expect(graph["245"].inputs.images).toEqual(["compose",0]);
    expect(graph["245"].inputs.fps).toEqual(["2",2]);
  });

  it("sets every window length from one frame count",()=>{
    const graph=run(assets,{},81);
    for(const id of ["261:247","maskSlice","maskSliceL","maskSliceR","sourceSlice","crop"])expect(graph[id].inputs.length).toBe(81);
    expect(graph["canvas"].inputs.batch_size).toBe(81);
    const short=run(assets,{},33);
    for(const id of ["261:247","maskSlice","maskSliceL","maskSliceR","sourceSlice","crop"])expect(short[id].inputs.length).toBe(33);
    expect(short["canvas"].inputs.batch_size).toBe(33);
  });

  it("rounds a window to 4n+1 and never runs past 81 frames",()=>{
    expect(fromStillWindowFrames(81)).toBe(81);
    expect(fromStillWindowFrames(33)).toBe(33);
    expect(fromStillWindowFrames(30)).toBe(29);
    expect(fromStillWindowFrames(263)).toBe(81);
    expect(()=>fromStillWindowFrames(0)).toThrow("positive whole number");
  });

  it("writes the scene and motion words even when the controls are empty",()=>{
    const graph=run(assets);
    expect(graph["605"].inputs.value).toBe(fromStillScene());
    expect(graph["604"].inputs.value).toBe(fromStillMotion());
    expect(graph["605"].inputs.value).toContain("orange studio");
    expect(graph["605"].inputs.value).not.toContain("moustache");
  });

  it("appends the user's words after the reviewed sentence",()=>{
    const graph=run(assets,{prompt:"No sunglasses.",pose_prompt:"Keep it calm."});
    expect(graph["605"].inputs.value).toBe(`${fromStillScene()}\n\nNo sunglasses.`);
    expect(graph["604"].inputs.value).toBe(`${fromStillMotion()}\n\nKeep it calm.`);
  });

  it("refuses a run without a still",()=>{
    expect(()=>run({source_video:"comfyfield-clip.mp4"})).toThrow("Missing asset: anchor_image");
  });
});

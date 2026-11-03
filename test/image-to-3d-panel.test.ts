import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {imageTo3DWorkflows} from "../src/team/three-d/ImageTo3DPanel";
const pack=(id:string)=>JSON.parse(readFileSync(`native-workflows/${id}/manifest.json`,"utf8"));
describe("native Image to 3D",()=>{
  it("offers only implemented local image-to-model workflows",()=>{
    const hy=pack("hunyuan3d-21"),tr=pack("trellis2-image-to-3d");
    expect(imageTo3DWorkflows([hy,tr,{...hy,id:"text-only",inputs:[]},{...hy,id:"image-output",outputs:[{type:"image"}]},{...hy,id:"unimplemented",routes:[{execution:"local_comfy",implementation:"planned"}]}]).map(m=>m.id)).toEqual([hy.id,tr.id]);
  });
});

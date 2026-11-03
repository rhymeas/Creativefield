import {describe,it,expect} from "vitest";
import {NATIVE_THREE_D_TOOLS} from "../src/team/three-d/tools";
import {readFileSync} from "node:fs";
import {nativeWorkflowHash} from "../src/team/workflow-navigation";
import {routeState,type RouteInput} from "../src/team/route-state";
const pack=(id:string)=>JSON.parse(readFileSync(`native-workflows/${id}/manifest.json`,"utf8"));
const ready:RouteInput={section:"video",canCreate:true,catalogueKnown:true,video:true,motion:true,image:true,audioKnown:true,audio:true,trimKnown:true,trim:true};
describe("native workflow navigation",()=>{
 it("exposes the implemented native 3D panels",()=>{expect(NATIVE_THREE_D_TOOLS.map(t=>t.id)).toEqual(["viewer","image","text","texture","mesh","workflows"]);});
 it("retains the selected 3D workflow instead of opening video",()=>{
  for(const id of ["hunyuan3d-21","trellis2-image-to-3d"])expect(nativeWorkflowHash(pack(id))).toBe(`#3d/image/${id}`);
 });
 it("keeps named image workflows stable across reload",()=>{expect(nativeWorkflowHash(pack("qwen-image-21-edit"))).toBe("#image/qwen-image-21-edit");});
 it("opens auxiliary mask contracts in their own native composer",()=>{
  const m={...pack("hunyuan3d-21"),id:"mask",category:"replacement",inputs:[],outputs:[{type:"mask"}]};
  expect(nativeWorkflowHash(m)).toBe("#workflow/mask");
  expect(routeState({...ready,section:"workflow",hash:"#workflow/mask",workflowIds:["mask"]})).toEqual({kind:"screen"});
 });
 it("rejects stale workflow and tool links and waits for catalogue first",()=>{
  for(const hash of ["#video/missing","#video/transform/missing","#workflow/missing"]){const r=routeState({...ready,section:hash.split("/")[0].slice(1),hash,workflowIds:[]});expect(r.kind).toBe("missing");}
  expect(routeState({...ready,hash:"#video/pending",catalogueKnown:false})).toEqual({kind:"checking"});
 });
});

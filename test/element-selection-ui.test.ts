import {describe,expect,it} from "vitest";
import {chooseElementInput,compatibleElementOptions} from "../src/team/element-selection";
import {defaultDraft} from "../src/team/state";
import type {Port} from "../src/capabilities/types";
import type {ReusableElement} from "../src/team/api";

const imagePort:Port={id:"start_image",label:"Start image",type:"image",required:true};
const elements:ReusableElement[]=[{id:"11111111-1111-4111-8111-111111111111",name:"Ari",kind:"character",description:"",created_at:"",asset_ids:["22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333"],assets:[
  {id:"22222222-2222-4222-8222-222222222222",project_id:"project",name:"portrait.png",media_type:"image",content_type:"image/png",bytes:"1",created_at:"",parent_id:null},
  {id:"33333333-3333-4333-8333-333333333333",project_id:"project",name:"performance.mp4",media_type:"video",content_type:"video/mp4",bytes:"1",created_at:"",parent_id:null},
]}];
const manifest={controls:[],inputs:[imagePort],audioPolicies:["mute"]} as unknown as Parameters<typeof defaultDraft>[0];

describe("Element input selection",()=>{
  it("offers only assets compatible with the concrete workflow port",()=>{
    expect(compatibleElementOptions(elements,imagePort)).toEqual([{value:`${elements[0].id}:${elements[0].asset_ids[0]}`,label:"Ari",note:"character · portrait.png"}]);
  });
  it("replaces direct media with stable Element and asset IDs",()=>{
    const draft={...defaultDraft(manifest),inputs:{start_image:"direct-asset"}},value=`${elements[0].id}:${elements[0].asset_ids[0]}`;
    const selected=chooseElementInput(draft,"start_image",value);
    expect(selected.inputs).toEqual({});expect(selected.elementInputs).toEqual({start_image:{elementId:elements[0].id,assetId:elements[0].asset_ids[0]}});
    expect(chooseElementInput(selected,"start_image","").elementInputs).toEqual({});
  });
});

import {describe,expect,it} from "vitest";
import {buildCatalogue} from "../src/capabilities/catalogue";
import {providers} from "../src/pipelines/registry";
import type {Port} from "../src/capabilities/types";
import type {ReusableElement} from "../src/team/api";
import {characterElementOptions,elementBinding} from "../src/team/element-selection";
import {chooseWorkflow,eligible,newShot,shotErrors} from "../src/team/storyboard-state";

const catalogue=buildCatalogue(providers).map(b=>b.manifest),imageModel=catalogue.find(m=>m.category==="i2v"&&eligible(m))!;
const imagePort:Port={id:"start_image",label:"Start image",type:"image",required:true},videoPort:Port={id:"start_image",label:"Start image",type:"video",required:true};
const asset=(id:string,name:string,content_type:string,media_type="image")=>({id,project_id:"project",name,media_type,content_type,bytes:"1",created_at:"",parent_id:null});
const elements:ReusableElement[]=[
  {id:"character-ari",name:"Ari",kind:"character",description:"",created_at:"",asset_ids:["ari-portrait","ari-clip"],assets:[asset("ari-portrait","portrait.png","image/png"),asset("ari-clip","performance.mp4","video/mp4","video")]},
  {id:"character-bea",name:"Bea",kind:"character",description:"",created_at:"",asset_ids:["bea-portrait"],assets:[asset("bea-portrait","face.jpg","image/jpeg")]},
  {id:"product-mug",name:"Mug",kind:"product",description:"",created_at:"",asset_ids:["mug-photo"],assets:[asset("mug-photo","mug.png","image/png")]},
];

describe("Saved character for a storyboard shot",()=>{
  it("offers characters only, and only the reference that fits the shot port",()=>{
    expect(characterElementOptions(elements,imagePort)).toEqual([
      {value:"character-ari:ari-portrait",label:"Ari",note:"character · portrait.png"},
      {value:"character-bea:bea-portrait",label:"Bea",note:"character · face.jpg"},
    ]);
    expect(characterElementOptions(elements,videoPort)).toEqual([{value:"character-ari:ari-clip",label:"Ari",note:"character · performance.mp4"}]);
  });

  it("reads a picker value as the Element and asset the render needs",()=>{
    expect(elementBinding("character-ari:ari-portrait")).toEqual({elementId:"character-ari",assetId:"ari-portrait"});
    for(const value of ["","character-ari","character-ari:",":ari-portrait"])expect(elementBinding(value)).toBeNull();
  });

  it("lets a shot pass validation through a character, never through media and a character at once",()=>{
    const shot={...chooseWorkflow(newShot(),imageModel),prompt:"Ari waves"};
    expect(shotErrors(shot,catalogue,[],elements).join(" ")).toContain("required");
    const bound={...shot,settings:{...shot.settings,elementInputs:{start_image:{elementId:"character-ari",assetId:"ari-portrait"}}}};
    expect(shotErrors(bound,catalogue,[],elements)).toEqual([]);
    const both={...bound,assets:[{role:"start_image",assetId:"ari-portrait"}]};
    expect(shotErrors(both,catalogue,[],elements).join(" ")).toContain("both");
  });
});

import {describe,expect,it} from "vitest";
import {placementDraftKey,readPlacementDraft,type PlacementDraft} from "../src/image/editor/placement-draft";

const uuid=(value:number)=>`00000000-0000-4000-8000-${String(value).padStart(12,"0")}`;
const scope={userId:uuid(1),workspaceId:uuid(2),projectId:uuid(3),assetId:uuid(4)};
const draft:PlacementDraft={version:1,...scope,characterId:uuid(5),capabilityId:"qwen-image-21-edit",capabilityVersion:"0.1",width:640,height:480,sceneHash:"a".repeat(64),mask:null,prompt:"Keep the costume"};
function header(width:number,height:number){const bytes=new Uint8Array(33);bytes.set([137,80,78,71,13,10,26,10]);const view=new DataView(bytes.buffer);view.setUint32(16,width);view.setUint32(20,height);return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;}
describe("scoped character placement drafts",()=>{
  it("retains an explicit deselection instead of reviving an old mask",()=>{
    expect(readPlacementDraft(JSON.stringify(draft),scope)).toEqual(draft);
    expect(readPlacementDraft(JSON.stringify({...draft,mask:header(640,480)}),scope)?.mask).toBe(header(640,480));
  });
  it("isolates drafts by user, workspace, project and immutable source",()=>{
    for(const key of Object.keys(scope) as Array<keyof typeof scope>){
      const other={...scope,[key]:uuid(9)};
      expect(readPlacementDraft(JSON.stringify(draft),other)).toBeNull();
      expect(placementDraftKey(scope)).not.toBe(placementDraftKey(other));
    }
  });
  it("rejects oversized, wrong-size and non-PNG mask payloads before decoding",()=>{
    for(const mask of [header(639,480),header(640,481),"data:image/svg+xml;base64,PHN2Zz4=","data:image/png;base64,"+"A".repeat(2000000)])expect(readPlacementDraft(JSON.stringify({...draft,mask}),scope)).toBeNull();
    expect(readPlacementDraft(JSON.stringify({...draft,width:2049}),scope)).toBeNull();
  });
  it("rejects malformed versions, hashes and unexpected fields",()=>{
    expect(readPlacementDraft("{",scope)).toBeNull();
    for(const change of [{version:2},{sceneHash:"wrong"},{extra:"field"},{prompt:"a".repeat(8001)}])expect(readPlacementDraft(JSON.stringify({...draft,...change}),scope)).toBeNull();
  });
});

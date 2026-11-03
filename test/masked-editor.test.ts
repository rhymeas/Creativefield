import {describe,expect,it} from "vitest";
import type {Asset} from "../src/team/api";
import type {CapabilityManifestV2} from "../src/capabilities/types";
import {clearMaskForSource,isMaskedEdit,matchingMask,maskSnapshot} from "../src/team/masked-state";
import {beginOperation,finishOperation,invalidateOperation,operationGate,ownsOperation} from "../src/team/operation-gate";

const manifest={mediaContract:{kind:"aligned_video_mask_v1",sourceInput:"source_video",maskInput:"edit_mask"},inputs:[{id:"source_video",label:"Source",type:"video",required:true},{id:"edit_mask",label:"Mask",type:"mask",representation:"video",required:true}]} as CapabilityManifestV2;
const base={project_id:"project",name:"asset",bytes:"1",created_at:"2026-10-16",parent_id:null} as Asset;
const source={...base,id:"source",media_type:"video",content_type:"video/mp4",sha256:"a".repeat(64)};
const receipt={validationVersion:1,sourceAssetId:"source",sourceSha256:"a".repeat(64),maskSha256:"b".repeat(64),width:512,height:320,fps:16,frames:17,timingDigest:"c".repeat(64),semantics:"white_edits_black_preserves"};
const mask={...base,id:"mask",media_type:"mask",content_type:"video/mp4",sha256:"b".repeat(64),parent_id:"source",metadata:{maskSequence:receipt}};

describe("manual-mask editor state",()=>{
  it("identifies the media contract and clears the linked mask on source change",()=>{
    expect(isMaskedEdit(manifest)).toBe(true);
    expect(clearMaskForSource({source_video:"old",edit_mask:"mask"},manifest)).toEqual({source_video:"old"});
  });
  it("accepts only the exact source-linked validated mask",()=>{
    expect(matchingMask(mask,source,"project",manifest)).toBe(true);
    expect(maskSnapshot(mask)?.frames).toBe(17);
    expect(matchingMask({...mask,parent_id:"other"},source,"project",manifest)).toBe(false);
    expect(matchingMask({...mask,sha256:"d".repeat(64)},source,"project",manifest)).toBe(false);
    expect(matchingMask({...mask,project_id:"other"},source,"project",manifest)).toBe(false);
  });
  it("releases a deferred upload when the session expires and allows a new upload after reauthentication",()=>{
    const gate=operationGate(),deferred=beginOperation(gate,"edit_mask");
    expect(gate.busy).toBe("edit_mask");
    invalidateOperation(gate);
    expect(gate.busy).toBe("");
    expect(ownsOperation(gate,deferred)).toBe(false);
    expect(finishOperation(gate,deferred)).toBe(false);
    const retry=beginOperation(gate,"edit_mask");
    expect(ownsOperation(gate,retry)).toBe(true);
    expect(finishOperation(gate,retry)).toBe(true);
    expect(gate.busy).toBe("");
  });
});

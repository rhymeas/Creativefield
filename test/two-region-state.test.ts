import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {buildTwoRegionIntent,readTwoRegionIntent,twoRegionKey} from "../src/team/video-mask/two-region-state";
import {isMaskedEdit} from "../src/team/masked-state";
import type {Asset} from "../src/team/api";
const manifest=JSON.parse(readFileSync('native-workflows/wan21-vace-two-region-edit/manifest.json','utf8')),id=(n:number)=>`${String(n).padStart(8,"0")}-0000-4000-8000-000000000001`,source={id:id(1),project_id:id(2),sha256:"a".repeat(64)} as Asset;
const mask=(n:number)=>({id:id(n),name:"Reviewed area",bytes:"100",created_at:"2026-10-22T00:00:00Z",project_id:source.project_id,parent_id:source.id,sha256:"b".repeat(64),media_type:"mask",content_type:"video/mp4",metadata:{maskSequence:{validationVersion:1,sourceAssetId:source.id,sourceSha256:source.sha256,maskSha256:"b".repeat(64),frames:17,fps:16,semantics:"white_edits_black_preserves"}}}) as Asset;
describe("combined edit intent and recovery",()=>{
  it("freezes both regions, prompts and supported controls without changing source assets",()=>{
    const controls={seed:12,strength:.5,prompt:"old"},prompts:[string,string]=[" Blue jacket "," Yellow backdrop "];
    const intent=buildTwoRegionIntent(manifest,id(2),source,mask(3),mask(4),id(5),prompts,controls,"frozen-batch-key");controls.seed=99;prompts[0]="changed";
    expect(intent.inputs).toEqual({source_video:source.id,edit_mask:id(3),edit_mask_2:id(4)});expect(intent.controls).toEqual({seed:12,seed_2:13,prompt:"Blue jacket",prompt_2:"Yellow backdrop"});expect(intent.audioPolicy).toBe("mute");
    expect(readTwoRegionIntent(intent,id(2),source.id,id(3),manifest.id)).toBe(intent);
  });
  it("rejects unreviewed, foreign or empty changes before building a request",()=>{
    for(const second of [{...mask(4),metadata:{}},{...mask(4),project_id:id(8)},{...mask(4),parent_id:id(8)}])expect(()=>buildTwoRegionIntent(manifest,id(2),source,mask(3),second as Asset,id(5),["blue","yellow"],{},"frozen-batch-key")).toThrow();
    expect(()=>buildTwoRegionIntent(manifest,id(2),source,mask(3),mask(4),id(5),["blue"," "],{},"frozen-batch-key")).toThrow();
  });
  it("scopes pending recovery to the same source, first mask, project and capability",()=>{
    const intent=buildTwoRegionIntent(manifest,id(2),source,mask(3),mask(4),id(5),["blue","yellow"],{},"frozen-batch-key");
    for(const value of [null,{...intent,projectId:id(8)},{...intent,inputs:{...intent.inputs,source_video:id(8)}},{...intent,inputs:{...intent.inputs,edit_mask:id(8)}},{...intent,controls:[]},{...intent,controls:{prompt:"blue",prompt_2:""}},{...intent,controls:{prompt:"blue",prompt_2:"yellow",seed:NaN}}])expect(readTwoRegionIntent(value,id(2),source.id,id(3),manifest.id)).toBe(null);
    expect(twoRegionKey("user","ws",id(2),source.id,id(3))).not.toBe(twoRegionKey("other","ws",id(2),source.id,id(3)));expect(isMaskedEdit(manifest)).toBe(false);
  });
});

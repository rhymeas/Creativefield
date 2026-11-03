import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {backgroundPixels,freezeScout,recoverScout,scoutRunRequest,scoutPreservation,SCOUT_DESTINATIONS} from "../src/image/editor/environment-scout";
import type {CapabilityManifestV2} from "../src/capabilities/types";
import type {Asset,Run} from "../src/team/api";
const id=(n:number)=>`a1234567-0000-4000-8000-${String(n).padStart(12,"0")}`;
const manifest=JSON.parse(readFileSync('native-workflows/flux2-klein-preserve-edit/manifest.json','utf8')) as CapabilityManifestV2;
const scope={userId:id(1),workspaceId:id(2),projectId:id(3)},inputs={source:{id:id(4),sha256:'a'.repeat(64)},mask:{id:id(5),sha256:'b'.repeat(64)},width:832,height:480};
const batch=()=>freezeScout(scope,manifest,id(6),'local',inputs,0);
describe('cached environment scouting',()=>{
  it('inverts subject alpha into an opaque editable background, retaining soft edges',()=>{
    const subject=new Uint8ClampedArray([255,0,0,255,255,0,0,0,255,0,0,128]),before=subject.slice();
    expect(Array.from(backgroundPixels(subject))).toEqual([0,0,0,255,255,255,255,255,127,127,127,255]);
    expect(subject).toEqual(before);
    expect(()=>backgroundPixels(new Uint8ClampedArray([0,0,0,0]))).toThrow('foreground');
    expect(()=>backgroundPixels(new Uint8ClampedArray([0,0,0,255]))).toThrow('background');
  });
  it('freezes source, mask, settings and one repeatable request key per destination',()=>{
    const b=batch(),one=scoutRunRequest(b,'forest');
    expect(one).toEqual(scoutRunRequest(JSON.parse(JSON.stringify(b)),'forest'));
    expect(one).toMatchObject({inputs:{source_image:inputs.source.id,edit_mask:inputs.mask.id},controls:{steps:4,mask_mode:'replace',feather_pct:0},audioPolicy:'mute'});
    expect(new Set(SCOUT_DESTINATIONS.map(d=>scoutRunRequest(b,d.id).idempotencyKey)).size).toBe(5);
    expect(()=>scoutRunRequest(b,'unknown')).toThrow('supported');
    expect(one.controls.prompt).toContain('protected foreground subject');
  });
  it('recovers accepted receipts without changing worker or request keys',()=>{
    const b=batch();b.runIds.forest=id(7);const restored=recoverScout(JSON.stringify(b),scope,manifest);
    expect(restored).toEqual(b);expect(scoutRunRequest(restored!,'coast')).toEqual(scoutRunRequest(b,'coast'));
    expect(recoverScout(JSON.stringify(b),{...scope,userId:id(9)},manifest)).toBeNull();
    expect(recoverScout(JSON.stringify(b),{...scope,projectId:id(9)},manifest)).toBeNull();
    expect(recoverScout(JSON.stringify(b),scope,{...manifest,version:'changed'})).toBeNull();
    expect(recoverScout(JSON.stringify({...b,runIds:{unknown:id(8)}}),scope,manifest)).toBeNull();
    expect(recoverScout(JSON.stringify({...b,pendingDestination:'coast'}),scope,manifest)?.pendingDestination).toBe('coast');
    expect(recoverScout(JSON.stringify({...b,pendingDestination:'unknown'}),scope,manifest)).toBeNull();
    expect(recoverScout('{',scope,manifest)).toBeNull();
  });
  it('rejects invalid geometry and incomplete checksums before submission',()=>{
    expect(()=>freezeScout(scope,manifest,id(6),'local',{...inputs,width:831},0)).toThrow();
    expect(()=>freezeScout(scope,manifest,id(6),'local',{...inputs,mask:{...inputs.mask,sha256:''}},0)).toThrow();
    expect(()=>freezeScout(scope,manifest,id(6),'local',inputs,4)).toThrow();
  });
  it('requires the exact project, source, output artifacts and dimensions in the measured receipt',()=>{
    const b=batch(),record={kind:'klein_still_v1',sourceAssetId:inputs.source.id,finalAssetId:id(7),candidateAssetId:id(8),effectiveMaskAssetId:id(9),qa:{width:832,height:480}};
    const run:Run={id:id(20),created_by:scope.userId,capability_version:manifest.version,error:null,created_at:'2026-10-22T00:00:00Z',updated_at:'2026-10-22T00:00:00Z',project_id:scope.projectId,capability_id:manifest.id,state:'succeeded',invocation:{inputs:{source_image:inputs.source.id,edit_mask:inputs.mask.id},controls:{}},output_ids:[id(7),id(8),id(9)]},asset:Asset={id:id(7),project_id:scope.projectId,name:'forest.png',media_type:'image',content_type:'image/png',bytes:'100',created_at:'2026-10-22T00:00:00Z',parent_id:inputs.source.id,metadata:{preservation:record}};
    expect(scoutPreservation(b,run,asset)).toEqual(record);
    expect(()=>scoutPreservation(b,{...run,project_id:id(10)},asset)).toThrow('receipt');
    expect(()=>scoutPreservation(b,{...run,output_ids:[id(7)]},asset)).toThrow('receipt');
    expect(()=>scoutPreservation(b,{...run,invocation:{inputs:{source_image:inputs.source.id,edit_mask:id(10)},controls:{}}},asset)).toThrow('receipt');
    expect(()=>scoutPreservation(b,run,{...asset,metadata:{preservation:{...record,sourceAssetId:id(10)}}})).toThrow('receipt');
  });
});

import {describe,expect,it,vi} from "vitest";
import type {CapabilityManifestV2} from "../src/capabilities/types";
import {elementInputsSchema,resolveRunInputs,validateRunInputSelections} from "../server/element-inputs";

const uuid=(n:number)=>`${String(n).padStart(8,"0")}-0000-4000-8000-000000000000`;
const manifest={inputs:[{id:"subject",label:"Subject",type:"image",required:true}],controls:[],routes:[],audioPolicies:[]} as unknown as CapabilityManifestV2;

describe("Element input bindings",()=>{
  it("accepts only strict UUID bindings and no more than sixteen ports",()=>{
    expect(elementInputsSchema.safeParse({subject:{elementId:uuid(1),assetId:uuid(2)}}).success).toBe(true);
    expect(elementInputsSchema.safeParse({subject:{elementId:"bad",assetId:uuid(2)}}).success).toBe(false);
    expect(elementInputsSchema.safeParse({subject:{elementId:uuid(1),assetId:uuid(2),snapshot:{forged:true}}}).success).toBe(false);
    expect(elementInputsSchema.safeParse(Object.fromEntries(Array.from({length:17},(_,i)=>[`p${i}`,{elementId:uuid(i+1),assetId:uuid(i+30)}]))).success).toBe(false);
  });

  it("rejects collisions, unknown ports and missing required ports before database work",()=>{
    expect(()=>validateRunInputSelections(manifest,{subject:uuid(1)},{subject:{elementId:uuid(2),assetId:uuid(3)}})).toThrow("both a direct asset");
    expect(()=>validateRunInputSelections(manifest,{}, {unknown:{elementId:uuid(2),assetId:uuid(3)}})).toThrow("Unknown input");
    expect(()=>validateRunInputSelections(manifest,{},{})).toThrow("Required input");
  });

  it("resolves an authorized Element asset and emits minimal immutable provenance",async()=>{
    const row={id:uuid(3),project_id:null,parent_id:null,media_type:"image",content_type:"image/png",sha256:"a".repeat(64),metadata:{mutable:true},storage_key:"private/path",element_kind:"character",name:"secret"};
    const client={query:vi.fn().mockResolvedValue({rows:[row]})} as any;
    const result=await resolveRunInputs(client,manifest,uuid(9),uuid(8),{}, {subject:{elementId:uuid(2),assetId:uuid(3)}});
    expect(result.inputIds).toEqual({subject:uuid(3)});
    expect(result.assets.subject.project_id).toBeNull();
    expect(result.elementInputSnapshots.subject).toEqual({validationVersion:1,inputPort:"subject",elementId:uuid(2),elementKind:"character",assetId:uuid(3),assetSha256:"a".repeat(64),assetMediaType:"image",assetProjectId:null});
    expect(JSON.stringify(result.elementInputSnapshots)).not.toMatch(/storage|private|mutable|secret|name/);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("LEFT JOIN assets d"),[uuid(9),uuid(2),uuid(3),uuid(8)]);
  });

  it("accepts a derived reference sheet but freezes the root Element asset provenance",async()=>{
    const root=uuid(3),sheet=uuid(4),row={id:sheet,project_id:uuid(8),parent_id:root,media_type:"image",content_type:"image/png",sha256:"b".repeat(64),metadata:{},storage_key:"private/sheet",element_kind:"character",source_asset_id:root,source_asset_sha256:"a".repeat(64),source_media_type:"image",source_project_id:null};
    const client={query:vi.fn().mockResolvedValue({rows:[row]})} as any;
    const result=await resolveRunInputs(client,manifest,uuid(9),uuid(8),{},{subject:{elementId:uuid(2),assetId:sheet}});
    expect(result.inputIds).toEqual({subject:sheet});
    expect(result.assets.subject).toMatchObject({id:sheet,parent_id:root,sha256:"b".repeat(64)});
    expect(result.elementInputSnapshots.subject).toEqual({validationVersion:1,inputPort:"subject",elementId:uuid(2),elementKind:"character",assetId:root,assetSha256:"a".repeat(64),assetMediaType:"image",assetProjectId:null});
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("d.parent_id=a.id"),[uuid(9),uuid(2),sheet,uuid(8)]);
  });

  it("rejects incompatible Element media after membership resolution",async()=>{
    const client={query:vi.fn().mockResolvedValue({rows:[{id:uuid(3),project_id:uuid(8),media_type:"video",content_type:"video/mp4",sha256:"a".repeat(64),element_kind:"character"}]})} as any;
    await expect(resolveRunInputs(client,manifest,uuid(9),uuid(8),{}, {subject:{elementId:uuid(2),assetId:uuid(3)}})).rejects.toThrow("does not match");
  });
});

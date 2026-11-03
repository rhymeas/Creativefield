import {readFileSync} from "node:fs";
import {describe,it,expect,vi} from "vitest";
import {characterEditBindings} from "../src/image/editor/character-references";
import type {CharacterRecord} from "../src/team/api";
import type {CapabilityBundle} from "../src/capabilities/types";
import {resolveRunInputs} from "../server/element-inputs";
import {compileLocal} from "../src/capabilities/compile";
import {addCharacterReferences} from "../src/image/image-state";

const uuid=(n:number)=>`${String(n).padStart(8,"0")}-0000-4000-8000-000000000000`;
const bundle:CapabilityBundle={manifest:JSON.parse(readFileSync("native-workflows/qwen-image-21-edit/manifest.json","utf8")),template:JSON.parse(readFileSync("native-workflows/qwen-image-21-edit/template.api.json","utf8"))};
const character=(count=3):CharacterRecord=>({id:uuid(1),projectId:uuid(2),elementId:uuid(3),name:"Fictional QA character",description:"",createdAt:"2026-10-22",referencePack:{version:1,references:Array.from({length:count},(_,ordinal)=>({ordinal,assetId:uuid(10+ordinal),assetProjectId:ordinal===1?null:uuid(2),assetSha256:String(ordinal).repeat(64),assetMediaType:"image",assetContentType:"image/png",assetBytes:100,assetMetadata:{}}))}});

describe("saved character packs in image editing",()=>{
  it("hands the full character pack to empty image reference slots without overwriting the draft",()=>{
    const draft={controls:{prompt:"A person in a forest",seed:42},inputs:{source_image:uuid(8)}};
    const result=addCharacterReferences(bundle.manifest,draft,character(),uuid(2));
    expect(result.controls).toEqual(draft.controls);
    expect(result.inputs).toEqual(draft.inputs);
    expect(result.elementInputs).toEqual(characterEditBindings(character(),bundle.manifest,uuid(2)));
    expect(()=>addCharacterReferences(bundle.manifest,{...draft,inputs:{...draft.inputs,reference_image:uuid(90)}},character(),uuid(2))).toThrow("Not enough empty reference slots");
    expect(draft.inputs).toEqual({source_image:uuid(8)});
  });
  it("uses the first saved view as an empty source and keeps the other views as references",()=>{
    const draft={controls:{prompt:"Make a portrait",seed:12}};
    const result=addCharacterReferences(bundle.manifest,draft,character(),uuid(2));
    expect(result.controls).toEqual(draft.controls);
    expect(result.inputs).toEqual({source_image:uuid(10)});
    expect(result.elementInputs).toEqual({reference_image:{elementId:uuid(3),assetId:uuid(11)},reference_image_2:{elementId:uuid(3),assetId:uuid(12)}});
  });
  it("satisfies a required reference for a single-view character",()=>{
    const result=addCharacterReferences(bundle.manifest,{controls:{prompt:"Portrait"}},character(1),uuid(2));
    expect(result.inputs?.source_image).toBe(uuid(10));
    expect(result.elementInputs?.reference_image?.assetId).toBe(uuid(10));
  });
  it("binds every saved reference in ordinal order, including workspace-shared images",()=>{
    const record=character();record.referencePack.references.reverse();
    expect(characterEditBindings(record,bundle.manifest,uuid(2))).toEqual({reference_image:{elementId:uuid(3),assetId:uuid(10)},reference_image_2:{elementId:uuid(3),assetId:uuid(11)},reference_image_3:{elementId:uuid(3),assetId:uuid(12)}});
  });
  it("does not truncate oversized packs or silently fit a multi-view pack to an older route",()=>{
    expect(()=>characterEditBindings(character(4),bundle.manifest,uuid(2))).toThrow("up to three");
    const manifest={...bundle.manifest,inputs:bundle.manifest.inputs.slice(0,2)};
    expect(()=>characterEditBindings(character(),manifest,uuid(2))).toThrow("full reference pack");
    expect(Object.keys(characterEditBindings(character(1),manifest,uuid(2)))).toEqual(["reference_image"]);
  });
  it("rejects foreign, reordered ambiguously, duplicate and incompatible references",()=>{
    expect(()=>characterEditBindings(character(),bundle.manifest,uuid(9))).toThrow("this project");
    const duplicate=character();duplicate.referencePack.references[1].assetId=uuid(10);
    expect(()=>characterEditBindings(duplicate,bundle.manifest,uuid(2))).toThrow("order is invalid");
    const gap=character();gap.referencePack.references[1].ordinal=9;
    expect(()=>characterEditBindings(gap,bundle.manifest,uuid(2))).toThrow("order is invalid");
    const foreign=character();foreign.referencePack.references[1].assetProjectId=uuid(9);
    expect(()=>characterEditBindings(foreign,bundle.manifest,uuid(2))).toThrow("another project");
    const video=character();video.referencePack.references[1].assetMediaType="video";
    expect(()=>characterEditBindings(video,bundle.manifest,uuid(2))).toThrow("incompatible");
  });
  it("passes the pack through ordinary server resolution and freezes all three Element receipts",async()=>{
    const record=character(),bindings=characterEditBindings(record,bundle.manifest,uuid(2));
    const rows=[{id:uuid(8),project_id:uuid(2),media_type:"image",content_type:"image/png",sha256:"a".repeat(64),storage_key:"source",metadata:{}},...record.referencePack.references.map(reference=>({id:reference.assetId,project_id:reference.assetProjectId,media_type:"image",content_type:"image/png",sha256:reference.assetSha256,storage_key:"private/ref",metadata:{},element_kind:"character"}))];
    const client={query:vi.fn()};rows.forEach(row=>client.query.mockResolvedValueOnce({rows:[row]}));
    const resolved=await resolveRunInputs(client as never,bundle.manifest,uuid(7),uuid(2),{source_image:uuid(8)},bindings);
    expect(Object.keys(resolved.elementInputSnapshots)).toEqual(["reference_image","reference_image_2","reference_image_3"]);
    expect(resolved.elementInputSnapshots.reference_image_2.assetProjectId).toBeNull();
    expect(resolved.elementInputSnapshots.reference_image_3.assetSha256).toBe("2".repeat(64));
    expect(JSON.stringify(resolved.elementInputSnapshots)).not.toContain("private/ref");
    const graph=compileLocal(bundle,{capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:Object.fromEntries(Object.keys(resolved.inputIds).map((port,index)=>[port,`comfyfield-view-${index}.png`])),controls:{prompt:"Place the fictional character in this scene."},audioPolicy:"mute"});
    expect(graph["477"].inputs.image).toBe("comfyfield-view-3.png");
    expect(client.query).toHaveBeenNthCalledWith(3,expect.stringContaining("LEFT JOIN assets d"),[uuid(7),uuid(3),uuid(11),uuid(2)]);
  });
});

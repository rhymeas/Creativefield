import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {ApiError} from "../src/team/api";
import {defaultImageDraft} from "../src/image/image-state";
import type {CapabilityManifestV2} from "../src/capabilities/types";
import {hasUnresolvedLegacyPhotoset,identityPhotosetCanResume,identityPhotosetDrafts,identityPhotosetRequest,identityPhotosetStorageKey,identityPhotosetWorkerAllowed,readIdentityPhotoset,submitIdentityPhotoset,type IdentityPhotosetRecipe} from "../src/image/identity-photoset";
const manifest=JSON.parse(readFileSync("native-workflows/fibo2-edit/manifest.json","utf8")) as CapabilityManifestV2;
const draft={inputs:{source_image:"source"},elementInputs:{reference_image:{elementId:"character",assetId:"reference"}},controls:{prompt:"Keep the same character",seed:42}};
describe("character photoset requests",()=>{
  it("retains an uncertain or partly submitted batch across worker and version changes",()=>{
    const scope={userId:"u",workspaceId:"ws",projectId:"project",model:manifest.id};
    const original:IdentityPhotosetRecipe={id:"batch",...scope,workerId:"worker-a",version:manifest.version,drafts:identityPhotosetDrafts(manifest,draft,"one\ntwo"),accepted:{0:"run-1"},pending:1};
    for(const saved of [original,{...original,pending:undefined}]){
      const restored=readIdentityPhotoset(JSON.stringify(saved),scope)!;
      expect(restored).toEqual(saved);
      expect(identityPhotosetCanResume(restored,"worker-b",manifest.version)).toBe(false);
      expect(identityPhotosetCanResume(restored,"worker-a","other-version")).toBe(false);
      expect(identityPhotosetCanResume(restored,"worker-a",manifest.version)).toBe(true);
      expect(restored.id).toBe("batch");
      expect(restored.accepted[0]).toBe("run-1");
    }
    expect(readIdentityPhotoset(JSON.stringify(original),{...scope,userId:"other"})).toBeNull();
  });
  it("freezes distinct user variations with the same character and prompt",()=>{
    const variants=identityPhotosetDrafts(manifest,draft,"in a studio\nin a park");
    expect(variants.map(v=>v.controls.prompt)).toEqual(["Keep the same character\n\nin a studio","Keep the same character\n\nin a park"]);
    expect(variants[0].elementInputs).toEqual(draft.elementInputs);
    draft.elementInputs.reference_image.assetId="changed";
    expect(variants[0].elementInputs?.reference_image.assetId).toBe("reference");
    const scope={projectId:"project",workerId:"worker",id:"batch"};
    expect(identityPhotosetRequest(manifest,variants[0],scope,0)).toEqual(identityPhotosetRequest(manifest,variants[0],scope,0));
    expect(identityPhotosetRequest(manifest,variants[0],scope,0).idempotencyKey).not.toBe(identityPhotosetRequest(manifest,variants[1],scope,1).idempotencyKey);
  });
  it("requires a local single-user queue and bounds variation count",()=>{
    expect(identityPhotosetWorkerAllowed(true,"http://127.0.0.1:8288")).toBe(true);
    expect(identityPhotosetWorkerAllowed(false,"http://127.0.0.1:8288")).toBe(false);
    expect(identityPhotosetWorkerAllowed(true,"http://remote:8188")).toBe(false);
    expect(()=>identityPhotosetDrafts(manifest,draft,"one")).toThrow("two to eight");
    expect(()=>identityPhotosetDrafts(manifest,draft,Array(9).fill("x").join("\n"))).toThrow("two to eight");
  });
  it("stops submissions and resumes without duplicating accepted requests",async()=>{
    const recipe:IdentityPhotosetRecipe={id:"batch",workspaceId:"ws",projectId:"project",userId:"u",workerId:"worker",model:manifest.id,version:manifest.version,drafts:identityPhotosetDrafts(manifest,{inputs:{source_image:"source"},controls:{prompt:"same",seed:42}},"one\ntwo"),accepted:{}};
    let saved=recipe,stop=false;const keys:string[]=[];
    const call=async (_path:string,_method?:string,body?:unknown)=>{keys.push((body as {idempotencyKey:string}).idempotencyKey);return {id:`run-${keys.length}`};};
    await submitIdentityPhotoset(recipe,manifest,call as never,r=>{saved=r;},()=>stop,()=>{stop=true;});
    expect(keys).toHaveLength(1);expect(saved.accepted[0]).toBe("run-1");
    stop=false;await submitIdentityPhotoset(saved,manifest,call as never,r=>{saved=r;},()=>stop,()=>{});
    expect(keys).toHaveLength(2);expect(new Set(keys).size).toBe(2);
  });
  it("retains uncertain requests for idempotent retry but unlocks definitive first rejection",async()=>{
    const recipe:IdentityPhotosetRecipe={id:"batch",workspaceId:"ws",projectId:"project",userId:"u",workerId:"worker",model:manifest.id,version:manifest.version,drafts:identityPhotosetDrafts(manifest,{inputs:{source_image:"source"},controls:{prompt:"same",seed:42}},"one\ntwo"),accepted:{}};
    let saved=recipe;const store=(r:IdentityPhotosetRecipe)=>{saved=r;};
    await expect(submitIdentityPhotoset(recipe,manifest,(async()=>{throw new ApiError(422,"invalid");}) as never,store,()=>false,()=>{})).rejects.toThrow("invalid");
    expect(saved.pending).toBeUndefined();
    await expect(submitIdentityPhotoset(recipe,manifest,(async()=>{throw new Error("offline");}) as never,store,()=>false,()=>{})).rejects.toThrow("offline");
    expect(saved.pending).toBe(0);const firstKey=identityPhotosetRequest(manifest,saved.drafts[0],saved,0).idempotencyKey;
    const keys:string[]=[];await submitIdentityPhotoset(saved,manifest,(async(_p:string,_m:string,b:{idempotencyKey:string})=>{keys.push(b.idempotencyKey);return {id:"ok"};}) as never,store,()=>false,()=>{});
    expect(keys[0]).toBe(firstKey);expect(saved.pending).toBeUndefined();
  });
});


describe("Remix image variants",()=>{
  it("does not reopen a character photoset when entering Remix and preserves legacy character batches",()=>{
    const scope={userId:"u",workspaceId:"w",projectId:"p",model:"fibo2-edit"};
    expect(identityPhotosetStorageKey(scope,"character")).toBe("comfyfield:photoset:u:w:p:fibo2-edit");
    expect(identityPhotosetStorageKey(scope,"remix")).not.toBe(identityPhotosetStorageKey(scope,"character"));
    expect(identityPhotosetStorageKey({...scope,projectId:"other"},"remix")).not.toBe(identityPhotosetStorageKey(scope,"remix"));
  });
  it("does not permit a new Remix batch over an unresolved legacy submission",()=>{
    const scope={userId:"u",workspaceId:"w",projectId:"p",model:"fibo2-edit"};
    const pending=JSON.stringify({...scope,pending:0});
    expect(hasUnresolvedLegacyPhotoset(pending,scope)).toBe(true);
    expect(hasUnresolvedLegacyPhotoset(JSON.stringify(scope),scope)).toBe(false);
    expect(hasUnresolvedLegacyPhotoset(pending,{...scope,projectId:"other"})).toBe(false);
    expect(hasUnresolvedLegacyPhotoset(null,scope)).toBe(false);
  });
  for(const id of ["fibo2-edit","qwen-image-21-edit"]){
    it(`submits the selected source, references and each user's instruction to ${id}`,async()=>{
      const model=JSON.parse(readFileSync(`native-workflows/${id}/manifest.json`,"utf8")) as CapabilityManifestV2;
      const source:ImageDraftForTest={inputs:{source_image:"original",reference_image:"ref-1",reference_image_2:"ref-2"},elementInputs:{reference_image_3:{elementId:"character",assetId:"ref-3"}},controls:{...defaultImageDraft(model).controls,prompt:"Use the product from the reference",seed:42}};
      const drafts=identityPhotosetDrafts(model,source,"Red backdrop\nBlue backdrop");
      source.inputs.reference_image="changed";source.elementInputs.reference_image_3.assetId="changed";
      const recipe:IdentityPhotosetRecipe={id:"remix",workspaceId:"ws",projectId:"project",userId:"u",workerId:"worker",model:id,version:model.version,drafts,accepted:{}};
      const submitted:Array<ReturnType<typeof identityPhotosetRequest>>=[];
      await submitIdentityPhotoset(recipe,model,(async(_path:string,_method:string,body:ReturnType<typeof identityPhotosetRequest>)=>{submitted.push(body);return {id:`run-${submitted.length}`};}) as never,()=>{},()=>false,()=>{});
      expect(submitted).toHaveLength(2);
      for(const [index,body] of submitted.entries()){
        expect(body.capabilityId).toBe(id);
        expect(body.inputs).toEqual({source_image:"original",reference_image:"ref-1",reference_image_2:"ref-2"});
        expect(body.elementInputs).toEqual({reference_image_3:{elementId:"character",assetId:"ref-3"}});
        expect(body.controls.prompt).toBe(`Use the product from the reference\n\n${index===0?"Red backdrop":"Blue backdrop"}`);
      }
    });
  }
});
type ImageDraftForTest={inputs:Record<string,string>;elementInputs:Record<string,{elementId:string;assetId:string}>;controls:Record<string,string|number|boolean>};

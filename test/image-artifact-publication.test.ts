import {describe,expect,it} from "vitest";
import {HttpError} from "../server/auth";
import {exactImageArtifactSlotSpecs,planArtifactSlots,resolveDeclaredImageArtifacts,sanitizedImageProvenance,sanitizedRelationMetadata,stableArtifactId,stableArtifactSlotId,validateStagedArtifactBatch} from "../server/image-artifacts";
import type {ImageArtifactsContractV1} from "../src/capabilities/image-artifacts";

const runId="11111111-1111-4111-8111-111111111111";
const contract:ImageArtifactsContractV1={kind:"image_artifacts_v1",schemaVersion:1,maxArtifacts:2,artifacts:[{
  id:"edited",outputPort:"edited_image",node:"11",nodeOutput:0,role:"image",contentType:"image/png",
  cardinality:{min:1,max:1},indexing:{strategy:"history_array",start:0},dimensions:{mode:"bounded",maxWidth:64,maxHeight:64,maxPixels:4096},maxBytes:1024,alpha:"allow",parents:[],
}]};

describe("image artifact publication contracts",()=>{
  it("derives stable domain-separated slot and asset UUIDs",()=>{
    const slot=stableArtifactSlotId(runId,"composite",0),asset=stableArtifactId(runId,"composite",0);
    expect(slot).toBe(stableArtifactSlotId(runId,"composite",0));
    expect(asset).toBe(stableArtifactId(runId,"composite",0));
    expect(slot).not.toBe(asset);
    expect(slot).not.toBe(stableArtifactSlotId(runId,"composite",1));
    expect(slot[14]).toBe("8");
  });

  it("plans ordered roles and rejects duplicates before persistence",()=>{
    expect(planArtifactSlots(runId,[{role:"layer",ordinal:0,mediaType:"layer"},{role:"layer",ordinal:1,mediaType:"layer"}])).toHaveLength(2);
    expect(()=>planArtifactSlots(runId,[{role:"layer",ordinal:0,mediaType:"layer"},{role:"layer",ordinal:0,mediaType:"layer"}])).toThrow(HttpError);
  });

  it("resolves only pinned SaveImage arrays in declaration order",()=>{
    const file={filename:"edited.png",subfolder:"canvas/output",type:"output"};
    expect(resolveDeclaredImageArtifacts(contract,{11:{images:[file]},99:{images:[{filename:"unrelated.png",subfolder:"",type:"output"}]}})).toEqual([
      {declarationId:"edited",outputPort:"edited_image",node:"11",role:"image",ordinal:0,file},
    ]);
    expect(exactImageArtifactSlotSpecs(contract)).toEqual([{role:"image",ordinal:0,mediaType:"image"}]);
  });

  it("rejects missing, duplicate, unsafe and variable image history",()=>{
    expect(()=>resolveDeclaredImageArtifacts(contract,{})).toThrow(/cardinality/);
    expect(()=>resolveDeclaredImageArtifacts({...contract,artifacts:[{...contract.artifacts[0],cardinality:{min:1,max:2}}]},{11:{images:[
      {filename:"same.png",subfolder:"",type:"output"},{filename:"same.png",subfolder:"",type:"output"},
    ]}})).toThrow(/same image artifact/);
    expect(()=>resolveDeclaredImageArtifacts(contract,{11:{images:[{filename:"../escape.png",subfolder:"",type:"output"}]}})).toThrow(/unsafe/);
    expect(()=>resolveDeclaredImageArtifacts(contract,{11:{images:[{filename:"edited.png",subfolder:"",type:"input"}]}})).toThrow(/unsafe/);
    expect(()=>exactImageArtifactSlotSpecs({...contract,artifacts:[{...contract.artifacts[0],cardinality:{min:1,max:2}}]})).toThrow(/Variable/);
  });

  it("validates the complete staged batch and deterministic identities",()=>{
    const [plan]=planArtifactSlots(runId,[{role:"mask",ordinal:0,mediaType:"mask"}]);
    const artifact={...plan,name:"mask.png",contentType:"image/png" as const,storageKey:"workspace/file",sha256:"a".repeat(64),bytes:42,metadata:{imageValidation:{validationVersion:1,format:"png",width:4,height:4,hasAlpha:false,semantic:"mask"}},relations:[{assetId:"22222222-2222-4222-8222-222222222222",role:"source",ordinal:0}]};
    expect(validateStagedArtifactBatch(runId,[artifact])).toEqual([artifact]);
    expect(()=>validateStagedArtifactBatch(runId,[{...artifact,slotId:"33333333-3333-4333-8333-333333333333"}])).toThrow(/slot identity/);
    expect(()=>validateStagedArtifactBatch(runId,[{...artifact,contentType:"image/jpeg" as never}])).toThrow();
  });

  it("projects provenance through an allow-list",()=>{
    const projected=sanitizedImageProvenance({
      imageValidation:{validationVersion:1,format:"png",width:64,height:32,hasAlpha:true,semantic:"layer",decoder:"private"},
      generatedBy:{producerRunId:runId,capabilityId:"local-inpaint",routeId:"local",providerSecret:"nope"},
      storageKey:"private/path",graph:{secret:true},providerResponse:{token:"nope"},
    });
    expect(projected).toEqual({
      imageValidation:{validationVersion:1,format:"png",width:64,height:32,hasAlpha:true,semantic:"layer"},
      generatedBy:{producerRunId:runId,capabilityId:"local-inpaint",routeId:"local"},
    });
    expect(JSON.stringify(projected)).not.toMatch(/private|secret|token|graph|provider/i);
    expect(sanitizedRelationMetadata({assetSha256:"b".repeat(64),storagePath:"private",nested:{token:"nope"}})).toEqual({assetSha256:"b".repeat(64)});
  });
});

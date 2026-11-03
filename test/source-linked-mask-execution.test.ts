import {describe,expect,it} from "vitest";
import type {HistoryEntry} from "../src/comfy/client";
import type {CapabilityManifestV2} from "../src/capabilities/types";
import {declaredOutputFiles,pendingMaskMetadata,publicOutputLineage,permanentArtifactFailure} from "../server/execution";
import {HttpError} from "../server/auth";
import {MediaProbeUnavailableError} from "../server/media";

const file=(filename:string)=>({images:[{filename,subfolder:"",type:"output"}]});
const entry:HistoryEntry={outputs:{"8":file("mask.mp4"),"99":file("unrelated.mp4")}};
const contract:NonNullable<CapabilityManifestV2["outputContract"]>={
  kind:"source_linked_mask_v1",sourceInput:"source_video",maskOutput:"tracked_mask",artifactNode:"8",
  checkpointRequirementId:"model:sam21-tiny-fp16",semantics:"white_edits_black_preserves",
};

describe("source-linked mask execution contract",()=>{
  it("imports only the artifact node named by the pinned output contract",()=>{
    const graph={"8":{class_type:"SaveVideo"},"99":{class_type:"SaveVideo"}};
    expect(declaredOutputFiles(graph,entry,contract).map(output=>output.filename)).toEqual(["mask.mp4"]);
    expect(declaredOutputFiles(graph,entry).map(output=>output.filename)).toEqual(["mask.mp4","unrelated.mp4"]);
  });

  it("fails closed when the pinned artifact node is missing or is not SaveVideo",()=>{
    expect(()=>declaredOutputFiles({"99":{class_type:"SaveVideo"}},entry,contract)).toThrow("Pinned mask artifact node");
    expect(()=>declaredOutputFiles({"8":{class_type:"PreviewImage"}},entry,contract)).toThrow("Pinned mask artifact node");
  });

  it("does not substitute another SaveVideo output when the declared result is absent",()=>{
    expect(declaredOutputFiles({"8":{class_type:"SaveVideo"},"99":{class_type:"SaveVideo"}},{outputs:{"99":file("unrelated.mp4")}},contract)).toEqual([]);
  });

  it("publishes generated masks as pending without making them editable",()=>{
    const receipt={validationVersion:1,contract:"source_linked_mask_v1",sourceAssetId:"11111111-1111-4111-8111-111111111111",sourceSha256:"a".repeat(64),maskAssetId:"22222222-2222-4222-8222-222222222222",maskSha256:"b".repeat(64),projectId:"33333333-3333-4333-8333-333333333333",producerRunId:"44444444-4444-4444-8444-444444444444",width:160,height:96,fps:16,frames:17,timingDigest:"c".repeat(64),semantics:"white_edits_black_preserves",workflowId:"sam21-video-mask",workflowVersion:"0.1.0",routeId:"local",workflowRevisionId:"55555555-5555-4555-8555-555555555555",workflowSha256:"d".repeat(64),requiredCheckpoint:"sam2.1_hiera_tiny-fp16.safetensors",requiredCheckpointSha256:"e".repeat(64)};
    const metadata=pendingMaskMetadata(receipt);
    expect(metadata).toMatchObject({sourceLinkedMask:receipt,maskReview:{version:1,state:"pending"},generatedBy:{runId:receipt.producerRunId}});
    expect(metadata).not.toHaveProperty("maskSequence");
  });

  it("exposes output lineage without storage fields or arbitrary metadata",()=>{
    const linked={producerRunId:"44444444-4444-4444-8444-444444444444"};
    const output=publicOutputLineage({id:"asset",sha256:"a".repeat(64),storage_key:"workspace/secret",metadata:{sourceLinkedMask:linked,maskReview:{state:"pending"},generatedBy:{runId:linked.producerRunId},signedUrl:"https://secret.invalid"}});
    expect(output).toEqual({id:"asset",sha256:"a".repeat(64),metadata:{sourceLinkedMask:linked,maskReview:{state:"pending"},generatedBy:{runId:linked.producerRunId}}});
    expect(JSON.stringify(output)).not.toContain("storage");
    expect(JSON.stringify(output)).not.toContain("signedUrl");
  });

  it("keeps decoder contention retryable while terminal media errors fail closed",()=>{
    expect(permanentArtifactFailure(new HttpError(429,"busy"))).toBe(false);
    expect(permanentArtifactFailure(new HttpError(422,"invalid media"))).toBe(true);
    expect(permanentArtifactFailure(new MediaProbeUnavailableError("ffprobe missing"))).toBe(false);
    expect(permanentArtifactFailure(new Error("temporary storage failure"))).toBe(false);
  });
});

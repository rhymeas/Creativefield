import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {capabilityReadiness} from "../src/capabilities/readiness";
import {validateCapability,validateSourceLinkedMaskSnapshot} from "../src/capabilities/validate";
import {compileLocal} from "../src/capabilities/compile";
import type {CapabilityBundle,SourceLinkedMaskSnapshot} from "../src/capabilities/types";
import {canonicalTrackingControls,MAX_TRACKING_POINTS,trackingRequestMode,trackingRequestSchema,validateTrackingSelection,type TrackingSelection,type TrackingSourceSnapshot} from "../server/mask-tracking";
import {approvedGeneratedMaskReview,requestSchema} from "../server/run-submission";
import {assertLocalGraphPolicy} from "../src/capabilities/policy";

const manifest=JSON.parse(readFileSync("native-workflows/sam21-video-mask/manifest.json","utf8"));
const template=JSON.parse(readFileSync("native-workflows/sam21-video-mask/template.api.json","utf8"));
const bundle:CapabilityBundle={manifest,template};
const sam31Manifest=JSON.parse(readFileSync("native-workflows/sam31-video-mask/manifest.json","utf8"));
const sam31Template=JSON.parse(readFileSync("native-workflows/sam31-video-mask/template.api.json","utf8"));
const sam31Bundle:CapabilityBundle={manifest:sam31Manifest,template:sam31Template};
const source:TrackingSourceSnapshot={assetId:"source",projectId:"project",sha256:"a".repeat(64),width:512,height:320,fps:16,frames:17,timingDigest:"timing"};
const selection:TrackingSelection={sourceAssetId:"source",sourceSha256:"a".repeat(64),projectId:"project",frameIndex:0,objectIndex:1,points:[{x:100,y:100,kind:"include"}]};

describe("SAM 3.1 text-tracked video mask",()=>{
  it("loads a compilable prompt-tracking contract bound to the local video graph",()=>{
    expect(validateCapability(sam31Bundle)).toEqual([]);
    expect(sam31Manifest.outputContract).toMatchObject({
      kind:"source_linked_mask_v1",
      sourceInput:"source_video",
      maskOutput:"tracked_mask",
      artifactNode:"9",
      checkpointRequirementId:"model:sam3.1-multiplex-fp16",
      semantics:"white_edits_black_preserves",
      trackingMode:"prompt",
    });
    expect(sam31Manifest.routes[0].implementation).toBe("implemented");
    expect(()=>assertLocalGraphPolicy(sam31Template)).not.toThrow();
    const graph=compileLocal(sam31Bundle,{
      capabilityId:"sam31-video-mask",
      version:"0.1.0",
      routeId:"local",
      inputs:{source_video:"comfyfield-source.mp4"},
      controls:{prompt:"jacket",threshold:0.35},
      audioPolicy:"mute",
    });
    expect(graph["4"].inputs.text).toBe("jacket");
    expect(graph["5"].inputs.detection_threshold).toBe(0.35);
  });

  it("accepts only a strict, trimmed text prompt on the public tracking boundary",()=>{
    expect(trackingRequestSchema.parse({prompt:"  jacket  "})).toEqual({prompt:"jacket"});
    expect(trackingRequestMode({prompt:"jacket"})).toBe("prompt");
    expect(trackingRequestSchema.safeParse({prompt:"j"}).success).toBe(false);
    expect(trackingRequestSchema.safeParse({prompt:"jacket",points:[]}).success).toBe(false);
    expect(trackingRequestSchema.safeParse({prompt:"x".repeat(201)}).success).toBe(false);
  });
});

describe("SAM 2.1 tracking foundation",()=>{
  it("loads a valid experimental source-linked mask contract that remains unavailable",()=>{
    expect(validateCapability(bundle)).toEqual([]);
    const route=manifest.routes[0];
    const nodes=route.requirements.filter((r:any)=>r.kind==="node").map((r:any)=>r.name);
    const models=route.requirements.filter((r:any)=>r.kind==="model").map((r:any)=>`${r.location}/${r.name}`);
    expect(capabilityReadiness(manifest,"local",{online:true,nodes:[],models:[],credentials:[]}).state).toBe("install_required");
    expect(capabilityReadiness(manifest,"local",{online:true,nodes,models,credentials:[]}).state).toBe("unsupported");
    expect(manifest.outputContract.kind).toBe("source_linked_mask_v1");
    expect(manifest.outputContract.artifactNode).toBe("8");
    expect(manifest.outputContract.checkpointRequirementId).toBe("model:sam21-tiny-fp16");
    expect(manifest.mediaContract).toBeUndefined();
  });

  it("pins public local dependencies and does not declare a hosted route",()=>{
    const text=JSON.stringify(manifest);
    expect(text).toContain("0c35fff5f382803e2310103357b5e985f5437f32");
    expect(text).toContain("974d84a2a54080b3d00ef3d6be08da48635389834e02ad4793c6404b2dd2e851");
    const selector=template["4"].inputs.model,precision=template["4"].inputs.precision;
    expect(selector).toBe("sam2.1_hiera_tiny.safetensors");
    expect(precision).toBe("fp16");
    expect(selector.replace(/\.safetensors$/,`-${precision}.safetensors`)).toBe(manifest.routes[0].requirements.find((r:any)=>r.id==="model:sam21-tiny-fp16")?.name);
    expect(manifest.routes).toHaveLength(1);
    expect(manifest.routes[0].execution).toBe("local_comfy");
    expect(text.toLowerCase()).not.toContain("higgsfield");
    expect(()=>assertLocalGraphPolicy(template)).not.toThrow();
  });

  it("accepts bounded frame-zero points and rejects wrong source, empty include and out-of-frame coordinates",()=>{
    expect(validateTrackingSelection(selection,source)).toEqual([]);
    expect(validateTrackingSelection({...selection,sourceSha256:"b".repeat(64)},source)).toContain("Source snapshot changed");
    expect(validateTrackingSelection({...selection,points:[{x:1,y:1,kind:"exclude"}]},source)).toContain("Add at least one include point");
    expect(validateTrackingSelection({...selection,points:[{x:512,y:1,kind:"include"}]},source)).toContain("Point is outside the source frame");
    expect(validateTrackingSelection({...selection,points:Array.from({length:MAX_TRACKING_POINTS+1},()=>selection.points[0])},source)).toContain(`Use 1 to ${MAX_TRACKING_POINTS} points`);
  });

  it("accepts only strict public tracking intent and derives stable node controls",()=>{
    const tracking={frameIndex:0 as const,objectIndex:1 as const,points:[{x:9.5,y:7,kind:"include" as const},{x:3,y:4,kind:"exclude" as const},{x:2,y:1,kind:"include" as const}]};
    expect(trackingRequestSchema.parse(tracking)).toEqual(tracking);
    expect(canonicalTrackingControls(tracking.points)).toEqual({include_points:'[{"x":9.5,"y":7},{"x":2,"y":1}]',exclude_points:'[{"x":3,"y":4}]'});
    expect(trackingRequestSchema.safeParse({...tracking,sourceSha256:"forged"}).success).toBe(false);
    expect(trackingRequestSchema.safeParse({...tracking,frameIndex:1}).success).toBe(false);
    expect(trackingRequestSchema.safeParse({...tracking,points:[{x:1,y:2,kind:"exclude"}]}).success).toBe(false);
  });

  it("rejects client-owned receipts at the public request boundary",()=>{
    const request={projectId:"11111111-1111-4111-8111-111111111111",workerId:"22222222-2222-4222-8222-222222222222",idempotencyKey:"tracking-123",capabilityId:"sam21-video-mask",version:"0.1.0",routeId:"local",inputs:{source_video:"33333333-3333-4333-8333-333333333333"},controls:{},audioPolicy:"mute" as const,tracking:{frameIndex:0 as const,objectIndex:1 as const,points:[{x:1,y:2,kind:"include" as const}]}};
    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(requestSchema.safeParse({...request,mediaSnapshot:{forged:true}}).success).toBe(false);
    expect(requestSchema.safeParse({...request,maskReviewSnapshot:{forged:true}}).success).toBe(false);
  });

  it("returns validation errors for malformed point collections instead of throwing",()=>{
    for(const points of [{},"points",null]){
      expect(()=>validateTrackingSelection({...selection,points} as unknown as TrackingSelection,source)).not.toThrow();
      expect(validateTrackingSelection({...selection,points} as unknown as TrackingSelection,source)).toContain(`Use 1 to ${MAX_TRACKING_POINTS} points`);
    }
    expect(()=>validateTrackingSelection({...selection,points:[null]} as unknown as TrackingSelection,source)).not.toThrow();
    expect(validateTrackingSelection({...selection,points:[null]} as unknown as TrackingSelection,source)).toContain("Point is outside the source frame");
  });

  it("accepts only an exact server receipt for the frozen source and workflow",()=>{
    const expected={sourceAssetId:"source",sourceSha256:"a".repeat(64),maskAssetId:"mask",projectId:"project",producerRunId:"run",width:512,height:320,fps:16 as const,frames:17,timingDigest:"timing",workflowId:manifest.id,workflowVersion:manifest.version,routeId:"local",workflowRevisionId:"revision",workflowSha256:"d".repeat(64),requiredCheckpoint:"sam2.1_hiera_tiny-fp16.safetensors",requiredCheckpointSha256:"974d84a2a54080b3d00ef3d6be08da48635389834e02ad4793c6404b2dd2e851"};
    const receipt:SourceLinkedMaskSnapshot={validationVersion:1,contract:"source_linked_mask_v1",maskSha256:"c".repeat(64),semantics:"white_edits_black_preserves",...expected};
    expect(validateSourceLinkedMaskSnapshot(receipt,expected)).toBe(true);
    expect(validateSourceLinkedMaskSnapshot({...receipt,sourceSha256:"b".repeat(64)},expected)).toBe(false);
    expect(validateSourceLinkedMaskSnapshot({...receipt,maskSha256:"worker-claimed"},expected)).toBe(false);
  });

  it("keeps manual masks valid but requires an exact approved receipt for generated masks",()=>{
    const source={id:"11111111-1111-4111-8111-111111111111",project_id:"22222222-2222-4222-8222-222222222222",parent_id:null,sha256:"a".repeat(64),metadata:{}};
    const maskBase={id:"33333333-3333-4333-8333-333333333333",project_id:source.project_id,parent_id:source.id,sha256:"b".repeat(64)};
    expect(approvedGeneratedMaskReview({...maskBase,metadata:{}},source)).toBeUndefined();
    const producerRunId="44444444-4444-4444-8444-444444444444";
    const sourceLinked={validationVersion:1,contract:"source_linked_mask_v1",sourceAssetId:source.id,sourceSha256:source.sha256,maskAssetId:maskBase.id,maskSha256:maskBase.sha256,projectId:source.project_id,producerRunId,width:512,height:320,fps:16,frames:17,timingDigest:"c".repeat(64),semantics:"white_edits_black_preserves",workflowId:"sam21-video-mask",workflowVersion:"0.1.0",routeId:"local",workflowRevisionId:"55555555-5555-4555-8555-555555555555",workflowSha256:"d".repeat(64),requiredCheckpoint:"sam2.1_hiera_tiny-fp16.safetensors",requiredCheckpointSha256:"e".repeat(64)};
    const receipt={validationVersion:1,contract:"source_linked_mask_review_v1",decision:"approved",maskAssetId:maskBase.id,maskSha256:maskBase.sha256,sourceAssetId:source.id,sourceSha256:source.sha256,projectId:source.project_id,producerRunId,reviewedBy:"66666666-6666-4666-8666-666666666666",reviewedAt:"2026-10-16T20:00:00.000Z"};
    expect(()=>approvedGeneratedMaskReview({...maskBase,metadata:{sourceLinkedMask:sourceLinked,maskReview:{state:"pending"}}},source)).toThrow("Review and approve");
    expect(approvedGeneratedMaskReview({...maskBase,metadata:{sourceLinkedMask:sourceLinked,maskReview:{state:"approved",receipt}}},source)).toEqual(receipt);
    expect(()=>approvedGeneratedMaskReview({...maskBase,metadata:{sourceLinkedMask:sourceLinked,maskReview:{state:"approved",receipt:{...receipt,maskSha256:"f".repeat(64)}}}},source)).toThrow("no longer matches");
  });
});

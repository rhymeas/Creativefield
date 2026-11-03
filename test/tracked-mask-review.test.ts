import {describe,it,expect} from "vitest";
import type {Asset,Run} from "../src/team/api";
import {maskFrameBounds,trackedReviewGeometry} from "../src/team/video-mask/TrackedMaskReview";
import {pendingTrackingIntent,recoverableTrackedMasks,recoverableTrackingRun,trackingStorageKey} from "../src/team/video-mask/tracking-state";

const source:Asset={id:"source",project_id:"p",sha256:"a".repeat(64),name:"source.mp4",media_type:"video",content_type:"video/mp4",bytes:"100",created_at:"2026-10-21T20:00:00Z",parent_id:null};
const mask=(state:string,id=state)=>({id,name:"mask.mp4",bytes:"100",project_id:"p",parent_id:source.id,media_type:"mask",content_type:"video/mp4",created_at:"2026-10-21T20:00:00Z",metadata:{maskReview:{state},sourceLinkedMask:{sourceAssetId:source.id,sourceSha256:source.sha256,workflowId:"sam31-video-mask",width:832,height:480,fps:16,frames:17}}}) as Asset;
describe("tracked mask frame review and recovery",()=>{
  it("derives the extent from white pixels, including borders and an empty mask",()=>{
    const rgba=new Uint8ClampedArray(4*3*4);for(const [x,y]of [[1,0],[2,2]])rgba[(y*4+x)*4]=255;
    expect(maskFrameBounds(rgba,4,3)).toEqual({coverage:2/12,box:{left:25,top:0,width:50,height:100}});
    expect(maskFrameBounds(new Uint8ClampedArray(16),2,2)).toEqual({coverage:0,box:null});expect(()=>maskFrameBounds(rgba,2,2)).toThrow("Aligned");
  });
  it("requires the exact source identity and supported decoded frame envelope",()=>{
    expect(trackedReviewGeometry(source,mask("pending"))).toEqual({width:832,height:480,frames:17,reviewSourceId:source.id});
    expect(trackedReviewGeometry({...source,sha256:"b".repeat(64)},mask("pending"))).toBe(null);
    const invalid=mask("pending");(invalid.metadata!.sourceLinkedMask as any).frames=82;expect(trackedReviewGeometry(source,invalid)).toBe(null);
    expect(trackedReviewGeometry(source,{...mask("pending"),project_id:"other"})).toBe(null);
  });
  it("reviews manual masks against the pinned normalized source when required",()=>{
    const manual=mask("pending");manual.sha256="b".repeat(64);manual.metadata!.maskSequence=manual.metadata!.sourceLinkedMask;delete manual.metadata!.sourceLinkedMask;
    expect(trackedReviewGeometry(source,manual)?.reviewSourceId).toBe(source.id);
    manual.metadata!.maskNormalization={originalSourceAssetId:source.id,originalSourceSha256:source.sha256,normalizedSourceAssetId:"normalized-source",normalizedMaskAssetId:manual.id,normalizedMaskSha256:manual.sha256};
    expect(trackedReviewGeometry(source,manual)?.reviewSourceId).toBe("normalized-source");
    (manual.metadata!.maskNormalization as Record<string,unknown>).originalSourceSha256="changed";expect(trackedReviewGeometry(source,manual)).toBe(null);
  });
  it("recovers pending masks before approvals and excludes stale/rejected/foreign masks",()=>{
    const pending=mask("pending"),approved=mask("approved"),rejected=mask("rejected");
    expect(recoverableTrackedMasks([approved,rejected,pending,{...pending,id:"foreign",project_id:"other"}],source,"p","sam31-video-mask").map(m=>m.id)).toEqual([pending.id,approved.id]);
    expect(recoverableTrackedMasks([pending],{...source,sha256:"changed"},"p","sam31-video-mask")).toEqual([]);
    expect(recoverableTrackedMasks([pending],source,"p","sam21-video-mask")).toEqual([]);
  });
  it("keeps the frozen request identifier and scopes recovery to source/project/capability/user",()=>{
    const intent={projectId:"p",workerId:"w",idempotencyKey:"frozen-key",capabilityId:"sam31-video-mask",version:"old-pinned-version",routeId:"local",inputs:{source_video:"source"},controls:{threshold:.35},audioPolicy:"mute",tracking:{prompt:"jacket"},elementInputs:{}};
    expect(pendingTrackingIntent(intent,"p","source","sam31-video-mask")).toBe(intent);expect(pendingTrackingIntent(intent,"p","changed","sam31-video-mask")).toBe(null);
    expect(trackingStorageKey("u1","w","p","s","m")).not.toBe(trackingStorageKey("u2","w","p","s","m"));
    const run={id:"run",project_id:"p",created_by:"u",capability_id:"sam31-video-mask",state:"submission_unknown",created_at:"2026-10-21T20:00:00Z",invocation:{inputs:{source_video:source.id},controls:{},trackingSnapshot:{sourceSha256:source.sha256}}} as unknown as Run;
    expect(recoverableTrackingRun([run],source,"p","sam31-video-mask","u")).toBe(run);expect(recoverableTrackingRun([run],source,"p","sam31-video-mask","other")).toBeUndefined();expect(recoverableTrackingRun([{...run,state:"succeeded"}],source,"p","sam31-video-mask","u")).toBeUndefined();
  });
});

import {describe,expect,it} from "vitest";
import {buildVideoEditRequest,defaultVideoEditDraft,previewSeconds,videoEditDraftIssues,videoModeFromHash,type VideoEditPlan} from "../src/team/video-edit/state";
import type {Asset} from "../src/team/api";
import {pendingVideoEditKey,readPendingVideoEdit} from "../src/team/video-edit/pending";

const asset={id:"11111111-1111-4111-8111-111111111111",project_id:"22222222-2222-4222-8222-222222222222",name:"source.mp4",media_type:"video",content_type:"video/mp4",sha256:"a".repeat(64),bytes:"100",created_at:"",parent_id:null} satisfies Asset;
const plan:VideoEditPlan={contractVersion:1,operation:"trim",source:{sourceAssetId:asset.id,projectId:asset.project_id!,sha256:asset.sha256!,bytes:100,width:512,height:320,frameRate:{numerator:16,denominator:1},frameCount:48,hasAudio:true,container:"mov,mp4",videoCodec:"h264"},trim:{startFrame:0,endFrameExclusive:1,frames:1},continuation:null,output:{frameRate:{numerator:16,denominator:1},frames:1,durationTicks:1,timeBase:{numerator:1,denominator:16},audioPolicy:"mute",audio:null},planDigest:"b".repeat(64)};

describe("trim workspace bindings",()=>{
  it("restores explicit video destinations without treating unrelated hashes as mode changes",()=>{
    expect(videoModeFromHash("#video/trim/11111111-1111-4111-8111-111111111111")).toBe("trim");
    expect(videoModeFromHash("#video/storyboard")).toBe("storyboard");
    expect(videoModeFromHash("#video/transform")).toBe("transform");
    for(const hash of ["#library/runs/id","#imageedit/trim","#video","#video/unknown"])expect(videoModeFromHash(hash)).toBeNull();
  });
  it("requires the server-inspected envelope for the selected project video",()=>{
    expect(videoEditDraftIssues({...defaultVideoEditDraft,videoAssetId:asset.id,startFrame:"0",endFrameExclusive:"8"},[asset],null)).toContain("Wait for the server to inspect the selected video.");
  });
  it("rejects empty, reversed and out-of-envelope half-open ranges",()=>{
    expect(videoEditDraftIssues({...defaultVideoEditDraft,videoAssetId:asset.id,startFrame:"8",endFrameExclusive:"8"},[asset],plan)).toContain("End frame must be after start frame.");
    expect(videoEditDraftIssues({...defaultVideoEditDraft,videoAssetId:asset.id,startFrame:"0",endFrameExclusive:"49"},[asset],plan)).toContain("End frame must not exceed 48.");
  });
  it("builds only the implemented trim request with the chosen audio policy",()=>{
    const request=buildVideoEditRequest({...defaultVideoEditDraft,videoAssetId:asset.id,startFrame:"4",endFrameExclusive:"28"},[asset],plan,asset.project_id!,"stable-intent");
    expect(request).toEqual({projectId:asset.project_id,sourceAssetId:asset.id,startFrame:4,endFrameExclusive:28,extensionFrames:0,overlapFrames:0,audioPolicy:"preserve",idempotencyKey:"stable-intent",controls:{}});
    expect(request).not.toHaveProperty("workerId");
    const muted=buildVideoEditRequest({...defaultVideoEditDraft,videoAssetId:asset.id,startFrame:"4",endFrameExclusive:"28",audioPolicy:"mute"},[asset],plan,asset.project_id!,"stable-intent");
    expect(muted.audioPolicy).toBe("mute");
    const silent={...plan,source:{...plan.source,hasAudio:false}};
    expect(buildVideoEditRequest({...defaultVideoEditDraft,videoAssetId:asset.id,startFrame:"4",endFrameExclusive:"28"},[asset],silent,asset.project_id!,"stable-intent").audioPolicy).toBe("mute");
  });
  it("shows the selected source duration at its own frame rate",()=>{
    expect(previewSeconds(25,{numerator:24,denominator:1}).toFixed(3)).toBe("1.042");
    expect(previewSeconds(25,{numerator:16,denominator:1}).toFixed(3)).toBe("1.563");
    expect(previewSeconds(0,{numerator:24,denominator:1})).toBe(0);
  });
  it("rejects invalid continuation lengths instead of silently trimming",()=>{
    for(const extensionFrames of ["-1","NaN","1.5","81",""]){
      expect(()=>buildVideoEditRequest({...defaultVideoEditDraft,videoAssetId:asset.id,endFrameExclusive:"17",extensionFrames},[asset],plan,asset.project_id!,"stable-intent","worker")).toThrow("Extension must be 0–80 whole frames.");
    }
  });
  it("binds only the user request while the server derives generation context",()=>{
    const draft={...defaultVideoEditDraft,videoAssetId:asset.id,startFrame:"4",endFrameExclusive:"17",extensionFrames:"8",overlapFrames:"5",prompt:"The same white creature continues walking."};
    expect(videoEditDraftIssues(draft,[asset],plan)).toContain("Choose a ready local continuation worker in Models.");
    const body=buildVideoEditRequest(draft,[asset],plan,asset.project_id!,"stable-intent","worker");
    expect(body).toMatchObject({workerId:"worker",extensionFrames:8,overlapFrames:5,controls:{prompt:draft.prompt}});
    expect(body.controls).not.toHaveProperty("context_start_frame");
    expect(videoEditDraftIssues({...draft,overlapFrames:"14"},[asset],plan,"worker")).toContain("Overlap must fit inside the retained video.");
  });
  it("restores the exact unconfirmed request in a user/project-scoped tab record",()=>{
    const key=pendingVideoEditKey("user","workspace","project");
    expect(key).not.toBe(pendingVideoEditKey("other-user","workspace","project"));
    const draft={...defaultVideoEditDraft,videoAssetId:asset.id,endFrameExclusive:"17"};
    const frozen={key:"stable-intent",draft,body:buildVideoEditRequest(draft,[asset],plan,asset.project_id!,"stable-intent")};
    expect(readPendingVideoEdit({getItem:()=>JSON.stringify(frozen)},key)).toEqual(frozen);
    expect(readPendingVideoEdit({getItem:()=>"broken"},key)).toBeNull();
    expect(readPendingVideoEdit({getItem:()=>JSON.stringify({...frozen,key:"other"})},key)).toBeNull();
  });
});

import {describe,expect,it} from "vitest";
import {audioDraftIssues,buildAudioRequest,defaultAudioDraft} from "../src/team/audio/state";
import type {Asset} from "../src/team/api";

const video={id:"11111111-1111-4111-8111-111111111111",project_id:"p",name:"clip.mp4",media_type:"video",content_type:"video/mp4",sha256:"a".repeat(64),bytes:"1",created_at:"",parent_id:null} satisfies Asset;
const audio={id:"22222222-2222-4222-8222-222222222222",project_id:"p",name:"voice.wav",media_type:"audio",content_type:"audio/wav",sha256:"b".repeat(64),bytes:"1",created_at:"",parent_id:null} satisfies Asset;

describe("audio studio bindings",()=>{
  it("requires a pinned project video",()=>expect(audioDraftIssues(defaultAudioDraft,[])[0]).toContain("project video"));
  it("builds preserve with explicit source stream and timeline policies",()=>{
    const request=buildAudioRequest({...defaultAudioDraft,videoAssetId:video.id},[video],"project","intent");
    expect(request).toMatchObject({operation:"preserve",videoStreamIndex:0,sourceAudioStreamIndex:0,shortAudio:"pad_silence",longAudio:"trim",sourceGainDb:0});
    expect(request).not.toHaveProperty("audioAssetId");
  });
  it("binds replacement trim, offset, gain and external stream",()=>{
    const request=buildAudioRequest({...defaultAudioDraft,operation:"replace",videoAssetId:video.id,audioAssetId:audio.id,offsetSeconds:"1.25",audioStartSeconds:"2",audioEndSeconds:"5",audioGainDb:"-3"},[video,audio],"project","intent");
    expect(request).toMatchObject({operation:"replace",audioAssetId:audio.id,audioStreamIndex:0,offsetSeconds:1.25,audioStartSeconds:2,audioEndSeconds:5,audioGainDb:-3});
    expect(request).not.toHaveProperty("sourceAudioStreamIndex");
  });
  it("does not send audio-only controls for mute",()=>{
    const request=buildAudioRequest({...defaultAudioDraft,operation:"mute",videoAssetId:video.id},[video,audio],"project","intent");
    expect(Object.keys(request).sort()).toEqual(["expectedVideoSha256","idempotencyKey","loudness","operation","projectId","videoAssetId","videoStreamIndex"].sort());
  });
  it("rejects an invalid trim range before submission",()=>expect(audioDraftIssues({...defaultAudioDraft,operation:"replace",videoAssetId:video.id,audioAssetId:audio.id,audioStartSeconds:"5",audioEndSeconds:"2"},[video,audio])).toContain("Trim end must be after trim start."));
});

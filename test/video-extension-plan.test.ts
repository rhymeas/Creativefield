import {describe,it,expect} from "vitest";
import {planVideoExtension,wanGenerationFrames,type VideoSourceEnvelope} from "../server/video-extension-plan";

const source:VideoSourceEnvelope={validationVersion:1,sourceAssetId:"11111111-1111-4111-8111-111111111111",projectId:"22222222-2222-4222-8222-222222222222",sha256:"a".repeat(64),bytes:100,width:512,height:320,frameRate:{numerator:16,denominator:1},frameCount:81,timestampDigest:"b".repeat(64),hasAudio:true,durationSeconds:81/16,audioSeconds:81/16,container:"mov,mp4,m4a,3gp,3g2,mj2",videoCodec:"h264",ffmpegVersion:"ffmpeg fixture",ffprobeVersion:"ffprobe fixture"};
const base={contractVersion:1 as const,projectId:source.projectId,sourceAssetId:source.sourceAssetId,startFrame:4,endFrameExclusive:44,extensionFrames:0,overlapFrames:0};

describe("video extension plan",()=>{
  it("bounds full-source decoding independently of retained context",()=>{
    expect(()=>planVideoExtension({...base,extensionFrames:8,overlapFrames:5},{...source,frameCount:1000,durationSeconds:62.5,audioSeconds:62.5})).toThrow(/161 frames/);
    expect(planVideoExtension(base,{...source,frameCount:1000,durationSeconds:62.5,audioSeconds:62.5}).operation).toBe("trim");
  });
  it("freezes an exact half-open trim with a stable digest",()=>{
    const a=planVideoExtension(base,source),b=planVideoExtension(base,structuredClone(source));
    expect(a).toEqual(b);expect(a.operation).toBe("trim");expect(a.trim).toEqual({startFrame:4,endFrameExclusive:44,frames:40});expect(a.output).toMatchObject({frames:40,durationTicks:40,audioPolicy:"mute"});expect(a.planDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it("freezes audio preservation into output and digest",()=>{
    const muted=planVideoExtension(base,source),preserved=planVideoExtension({...base,audioPolicy:"preserve"},source);
    expect(preserved.output.audioPolicy).toBe("preserve");expect(preserved.output.audio).toEqual({sourceStartFrame:4,sourceEndFrameExclusive:44,continuation:null,sampleRate:48000,channels:2});expect(preserved.planDigest).not.toBe(muted.planDigest);
    const extended=planVideoExtension({...base,extensionFrames:10,overlapFrames:5,audioPolicy:"preserve"},source);expect(extended.output.audio?.continuation).toBe("silent");
    expect(()=>planVideoExtension({...base,audioPolicy:"preserve"},{...source,hasAudio:false})).toThrow("no audio stream to preserve");
  });
  it("rounds only the child generation envelope to 4n+1",()=>{
    const plan=planVideoExtension({...base,extensionFrames:10,overlapFrames:5},source);
    expect(plan.continuation).toEqual({contextStartFrame:39,contextEndFrameExclusive:44,overlapFrames:5,requestedFrames:10,generationFrames:17,discardTailFrames:2});
    expect(plan.output.frames).toBe(50);expect([1,5,9,13,17]).toEqual([1,2,6,10,14].map(wanGenerationFrames));
  });
  it("accepts non-16 FPS sources for trim but not for forward extension",()=>{
    const source24={...source,frameRate:{numerator:24,denominator:1},frameCount:120,durationSeconds:5};
    const trim=planVideoExtension(base,source24);
    expect(trim.output.frames).toBe(Math.round(40*16/24));expect(trim.output.durationTicks).toBe(trim.output.frames);expect(trim.output.frameRate).toEqual({numerator:16,denominator:1});
    const preserved=planVideoExtension({...base,preserveFrameRate:true},source24);
    expect(preserved.output).toMatchObject({frames:40,frameRate:{numerator:24,denominator:1},timeBase:{numerator:1,denominator:24}});
    expect(()=>planVideoExtension({...base,preserveFrameRate:true,extensionFrames:4,overlapFrames:1},source)).toThrow('only available for trim');
    expect(()=>planVideoExtension({...base,extensionFrames:17},source24)).toThrow("Forward extension requires a 16 FPS source");
  });
  it("rejects ambiguous, backward or invalid frame domains",()=>{
    for(const value of [{...base,startFrame:4,endFrameExclusive:4},{...base,endFrameExclusive:82},{...base,overlapFrames:1},{...base,extensionFrames:4,overlapFrames:0},{...base,extensionFrames:4,overlapFrames:41}])expect(()=>planVideoExtension(value,source)).toThrow();
    expect(()=>planVideoExtension({...base,extensionFrames:80,overlapFrames:5},source)).toThrow("81");
    expect(()=>planVideoExtension({...base,extensionFrames:4,overlapFrames:1}, {...source,width:510})).toThrow("geometry");
  });
});

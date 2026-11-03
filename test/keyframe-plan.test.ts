import {describe,expect,it} from "vitest";
import {planKeyframeSegments,qualifyKeyframeTiming,rescaleKeyframes,removeKeyframe,keyframeSpans,keyframePositions,fitKeyframesToModel} from "../src/team/keyframe-plan";
import {buildCatalogue} from "../src/capabilities/catalogue";
import {providers} from "../src/pipelines/registry";
import {loadServerCatalogue} from "../server/catalogue";

describe("keyframe segment timing",()=>{
  it("removes any keyframe while preserving the surviving segment prompts and timeline",()=>{
    const frames=[{assetId:'a',frame:0},{assetId:'b',frame:32},{assetId:'c',frame:80},{assetId:'d',frame:128}],prompts=['one','two','three'];
    expect(removeKeyframe(frames,prompts,0)).toEqual({frames:[{assetId:'b',frame:0},{assetId:'c',frame:48},{assetId:'d',frame:96}],prompts:['two','three']});
    expect(removeKeyframe(frames,prompts,1)).toEqual({frames:[frames[0],frames[2],frames[3]],prompts:['one','three']});
    expect(removeKeyframe(frames,prompts,3)).toEqual({frames:frames.slice(0,3),prompts:['one','two']});
    expect(()=>removeKeyframe(frames.slice(0,2),['one'],0)).toThrow();
  });
  it("keeps keyframes ordered and within the timeline when changing frame rate",()=>{
    const frames=[{assetId:'a',frame:0},{assetId:'b',frame:4},{assetId:'c',frame:8},{assetId:'d',frame:900}];
    expect(rescaleKeyframes(frames,60,16).map(f=>f.frame)).toEqual([0,4,8,240]);
    expect(rescaleKeyframes([{assetId:'a',frame:0},{assetId:'b',frame:32},{assetId:'c',frame:80}],16,24).map(f=>f.frame)).toEqual([0,48,120]);
    expect(()=>rescaleKeyframes(frames,0,16)).toThrow('frame rate');
  });
  it("snaps four keyframes to valid MiniMax H3 segment boundaries",async()=>{
    const model=(await loadServerCatalogue({log:()=>undefined})).find(item=>item.manifest.id==='h3-flf2v')!.manifest;
    const spans=keyframeSpans(model);expect(spans.slice(0,3)).toEqual([38,55,72]);
    const original=[{assetId:'a',frame:0},{assetId:'b',frame:32},{assetId:'c',frame:64},{assetId:'d',frame:96}];
    const fitted=fitKeyframesToModel(original,16,model);
    expect(fitted.map(frame=>frame.assetId)).toEqual(['a','b','c','d']);
    expect(fitted.at(-1)!.frame).toBeLessThanOrEqual(360);
    expect(()=>qualifyKeyframeTiming(model,planKeyframeSegments(fitted,['one','two','three']),24)).not.toThrow();
    for(let i=1;i<fitted.length;i++)expect(keyframePositions(fitted,i,model)).toContain(fitted[i].frame);
    expect(keyframePositions(fitted,1,model).every(n=>spans.includes(n)&&spans.includes(fitted[2].frame-n))).toBe(true);
  });
  it("shares boundaries once so independently generated segments align with the timeline",()=>{
    const segments=planKeyframeSegments([{assetId:"a",frame:0},{assetId:"b",frame:72},{assetId:"c",frame:168},{assetId:"d",frame:240}],["first","second","third"]);
    expect(segments.map(s=>s.frameCount)).toEqual([73,97,73]);
    expect(segments.reduce((sum,s)=>sum+s.frameCount,0)-(segments.length-1)).toBe(241);
    expect(segments.map(s=>s.prompt)).toEqual(["first","second","third"]);
  });
  it("accepts empty segment prompts but rejects missing entries and overlapping positions",()=>{
    expect(()=>planKeyframeSegments([{assetId:"a",frame:0},{assetId:"b",frame:0}],["move"])).toThrow();
    expect(planKeyframeSegments([{assetId:"a",frame:0},{assetId:"b",frame:24}],[""])[0].prompt).toBe("");
    expect(()=>planKeyframeSegments([{assetId:"a",frame:0},{assetId:"b",frame:24}],[])).toThrow();
  });
  it("matches actual first/last model frames and removes only duplicate boundaries",()=>{
    const model=buildCatalogue(providers).find(b=>b.manifest.id==='wan22-flf2v-14b')!.manifest;
    const segments=planKeyframeSegments([{assetId:'a',frame:0},{assetId:'b',frame:32},{assetId:'c',frame:80}],['move','turn']);
    const qualified=qualifyKeyframeTiming(model,segments,16);
    expect(qualified.map(s=>s.controlSeconds)).toEqual([2,3]);
    expect(qualified.map(s=>[s.assemblyStartFrame,s.assemblyFrames])).toEqual([[0,33],[1,48]]);
    expect(qualified.reduce((sum,s)=>sum+s.assemblyFrames,0)).toBe(81);
    expect(()=>qualifyKeyframeTiming(model,segments,24)).toThrow('model frame rate');
    const offGrid=planKeyframeSegments([{assetId:'a',frame:0},{assetId:'b',frame:33}],['move']);
    expect(()=>qualifyKeyframeTiming(model,offGrid,16)).toThrow('cannot end');
    const tooShort=planKeyframeSegments([{assetId:'a',frame:0},{assetId:'b',frame:8}],['move']);
    expect(()=>qualifyKeyframeTiming(model,tooShort,16)).toThrow('between');
  });
});

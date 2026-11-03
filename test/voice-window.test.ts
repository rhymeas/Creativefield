import {describe,it,expect} from "vitest";
import {voiceWindow} from "../src/team/audio/voice-window";
import {voiceReviewWindow,type VoiceProvenance} from "../src/team/audio/voice-review";
import type {Asset} from "../src/team/api";
describe("submitted portrait voice windows",()=>{
  const common={project_id:"project",name:"Fixture",bytes:"100",created_at:"2026-10-22T00:00:00Z",parent_id:null};
  const source:Asset={...common,id:"audio",media_type:"audio",content_type:"audio/wav",sha256:"a".repeat(64)},output:Asset={...common,id:"result",media_type:"video",content_type:"video/mp4",metadata:{frameRate:"25/1",durationSeconds:1.96}};
  const p:VoiceProvenance={capability_id:"wan21-infinitetalk",invocation:{controls:{length:2,audio_start:1.6},inputs:{source_audio:"audio"}},inputs:[{id:"audio",role:"source_audio",sha256:source.sha256!}],outputs:[{id:"result"}]};
  it("uses the submitted start and the compiler's 4n+1 duration, not a later draft",()=>{expect(voiceReviewWindow(p,source,output,"project","result")).toEqual({startSeconds:1.6,durationSeconds:1.96,fps:25});});
  it("rejects foreign, changed or unbound source/results and mismatched output timing",()=>{
    for(const [a,b] of [[{...source,sha256:"b".repeat(64)},output],[{...source,project_id:"foreign"},output],[source,{...output,id:"different"}],[source,{...output,metadata:{frameRate:"16/1",durationSeconds:1.96}}],[source,{...output,metadata:{frameRate:"25/1",durationSeconds:3}}]])expect(()=>voiceReviewWindow(p,a,b,"project","result")).toThrow();
    expect(()=>voiceReviewWindow({...p,invocation:{...p.invocation,inputs:{source_audio:"another"}}},source,output,"project","result")).toThrow();expect(()=>voiceReviewWindow({...p,outputs:[]},source,output,"project","result")).toThrow();
  });
  it("bounds preview seeking without silently shortening the requested window",()=>{expect(voiceWindow(1.6,1.96,6)).toEqual({start:1.6,end:3.56});expect(voiceWindow(0,undefined,2)).toEqual({start:0,end:2});expect(voiceWindow(1,1.02,2)).toEqual({start:1,end:2});for(const args of [[1,5,2],[-1,1,2],[2,1,2],[NaN,1,2],[0,0,2],[0,1,Infinity]])expect(voiceWindow(...args as [number,number,number])).toBeNull();});
});

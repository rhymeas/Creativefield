import {describe,expect,it} from "vitest";
import {performancePlanErrors,scriptRevisionErrors,voiceElementErrors,voiceTakeErrors,type PerformancePlanV1,type ScriptRevisionV1,type VoiceElementRevisionV1,type VoiceRoute,type VoiceTakeV1} from "../src/team/audio/voice-contracts";

const script:ScriptRevisionV1={kind:"script_revision_v1",id:"script-1",projectId:"project",revision:1,language:"en",lines:[{speakerCharacterId:"char-1",text:"Hello."}],createdBy:"user",createdAt:"2026-10-17T00:00:00Z"};
const voice:VoiceElementRevisionV1={kind:"voice_element_revision_v1",id:"voice-1",projectId:"project",revision:1,engine:"engine",model:"model",sourceType:"recorded",sourceHashes:["abc"],consentAttested:true,createdBy:"user",createdAt:"2026-10-17T00:00:00Z"};
const route:VoiceRoute={id:"local-voice",execution:"local",model:"model",license:"Apache-2.0",languages:["en"],ready:true};
const take:VoiceTakeV1={kind:"voice_take_v1",id:"take-1",projectId:"project",scriptRevisionId:"script-1",voiceElementRevisionId:"voice-1",routeId:"local-voice",parameters:{},durationSeconds:2,sampleRate:44100,channels:1,outputHash:"hash",review:"approved"};
const plan:PerformancePlanV1={kind:"performance_plan_v1",id:"plan-1",projectId:"project",voiceTakeId:"take-1",visualAssetId:"asset-1",targetDurationSeconds:2,frameRate:24,language:"en",lipSyncRouteId:"lipsync-local"};

describe("AUD-01 voice contracts",()=>{
  it("accepts complete provenance-complete records",()=>{
    expect(scriptRevisionErrors(script)).toEqual([]);
    expect(voiceElementErrors(voice)).toEqual([]);
    expect(voiceTakeErrors(take,route)).toEqual([]);
    expect(performancePlanErrors(plan,take)).toEqual([]);
  });

  it("fails closed without consent attestation or source hashes",()=>{
    expect(voiceElementErrors({...voice,consentAttested:false})).toContain("Consent and rights attestation is required.");
    expect(voiceElementErrors({...voice,sourceHashes:[]})).toContain("Voice source hashes are required.");
  });

  it("rejects takes on unknown or unready routes",()=>{
    expect(voiceTakeErrors(take)).toContain("Voice route is unknown.");
    expect(voiceTakeErrors(take,{...route,ready:false})).toContain("Voice route is not qualified as ready.");
    expect(voiceTakeErrors({...take,routeId:"other"},route)).toContain("Voice take route does not match its route definition.");
  });

  it("only lets manually approved takes enter a performance plan",()=>{
    expect(performancePlanErrors(plan,{...take,review:"pending"})).toContain("Only a manually approved voice take can enter a performance plan.");
    expect(performancePlanErrors(plan,{...take,projectId:"other"})).toContain("Performance plan and voice take projects differ.");
    expect(performancePlanErrors({...plan,lipSyncRouteId:""},take)).toContain("Performance plan needs a separately selected lip-sync route.");
  });
});

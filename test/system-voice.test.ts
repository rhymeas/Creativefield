import {describe,it,expect} from "vitest";
import {systemVoiceBody,systemVoiceRates} from "../server/system-voice-routes";
describe("local system voice request",()=>{
  const request={requestId:"00000000-0000-4000-8000-000000000001",text:"  A short line.  ",voice:"Installed voice",delivery:"natural"};
  it("bounds text and delivery and rejects client-supplied execution arguments",()=>{
    expect(systemVoiceBody.parse(request).text).toBe("A short line.");
    for(const patch of [{text:" "},{text:"x".repeat(401)},{voice:""},{delivery:"run-command"},{rate:9},{output:["C:", "/fixture/untrusted"].join("")},{requestId:"not-a-uuid"}])expect(systemVoiceBody.safeParse({...request,...patch}).success).toBe(false);
    expect(systemVoiceRates).toEqual({natural:0,calm:-2,brisk:2});
  });
  it("keeps punctuation and markup as ordinary literal speech input",()=>{
    const text="<speak>Hello</speak> '$HOME' $(test)";expect(systemVoiceBody.parse({...request,text}).text).toBe(text);
  });
});

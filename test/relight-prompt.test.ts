import {describe,expect,it} from "vitest";
import {inferLightGuide,relightPrompt} from "../src/image/relight-prompt";

describe("relight prompt and light guide",()=>{
  it("shows the requested bottom-right light without inventing golden light",()=>{
    expect(inferLightGuide("Night time, hard light from the bottom front right upwards")).toEqual({direction:"from the bottom front right",temperature:"auto"});
  });
  it("keeps the user's prompt unchanged unless the guide is explicitly adjusted",()=>{
    const prompt="Make it a night scene with hard light from the bottom front right";
    expect(relightPrompt(prompt)).toBe(prompt);
    expect(relightPrompt(prompt,"from the bottom right","Daylight")).toContain("Follow the user's written instructions if they differ");
  });
  it("reflects an explicitly requested colour in the schematic preview",()=>{
    expect(inferLightGuide("A cold blue hour scene lit from the left")).toEqual({direction:"from the left",temperature:"blue-hour"});
  });
});

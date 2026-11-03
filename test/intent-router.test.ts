import {describe,expect,it} from "vitest";
import {classifyIntent,intentLabel,intentPurpose} from "../src/team/intent/router";

describe("intent router",()=>{
  it("classifies still prompts as image work",()=>{
    expect(classifyIntent("A red cabin beside a frozen lake at dawn")).toBe("image");
    expect(classifyIntent("Portrait of a founder in soft studio light")).toBe("image");
  });

  it("classifies moving prompts as video work",()=>{
    expect(classifyIntent("A woman walking through a neon city, cinematic clip")).toBe("video");
    expect(classifyIntent("Slow pan across a desert at sunset")).toBe("video");
  });

  it("routes explicit production actions",()=>{
    expect(classifyIntent("Replace the jacket with a red coat")).toBe("edit");
    expect(classifyIntent("Trim the first two seconds")).toBe("trim");
    expect(classifyIntent("Storyboard three scenes for a product launch")).toBe("storyboard");
    expect(classifyIntent("Transfer the motion from this clip to a character")).toBe("motion");
    expect(classifyIntent("Add a voice over and music")).toBe("audio");
  });

  it("honours an explicit image or video override",()=>{
    expect(classifyIntent("Slow pan across a desert at sunset","image")).toBe("image");
    expect(classifyIntent("A still life of three pears","video")).toBe("video");
  });

  it("has no target without text",()=>{
    expect(classifyIntent("   ")).toBe("unknown");
    expect(intentLabel("unknown")).toMatch(/describe/i);
    expect(intentPurpose("video")).toMatch(/prompt/i);
  });

  it("names each destination the one way its screen is named",()=>{
    const labels=(["image","video","motion","edit","trim","storyboard","audio"] as const).map(intentLabel);
    expect(new Set(labels).size).toBe(labels.length);
    // The Change card and the All tools card call it "Copy moves".
    expect(intentLabel("motion")).toBe("Copy moves");
    // Making something is always "make"; Create is a tab inside Video.
    expect(intentPurpose("image")).toMatch(/^Make /);
    expect(intentPurpose("video")).toContain("Create in Video");
    expect(intentPurpose("edit")).toContain("Edit in Video");
  });
});

import {describe, expect, it} from "vitest";
import {acceptsFile} from "../src/ds/components";

describe("upload input compatibility", () => {
  it("accepts a supported image and rejects video for an image reference", () => {
    expect(acceptsFile("image/png,image/jpeg,image/webp", {name:"portrait.webp", type:"image/webp"})).toBe(true);
    expect(acceptsFile("image/png,image/jpeg,image/webp", {name:"clip.mp4", type:"video/mp4"})).toBe(false);
  });

  it("allows Photoshop files by extension when the browser supplies no MIME type", () => {
    expect(acceptsFile("image/*,.psd,.psb", {name:"LAYERS.PSD", type:""})).toBe(true);
    expect(acceptsFile("image/*,.psd,.psb", {name:"clip.mp4", type:"video/mp4"})).toBe(false);
  });

  it("honors exact video types and the unrestricted wildcard", () => {
    expect(acceptsFile("video/mp4", {name:"clip.webm", type:"video/webm"})).toBe(false);
    expect(acceptsFile("video/mp4", {name:"clip.mp4", type:"video/mp4"})).toBe(true);
    expect(acceptsFile("*/*", {name:"clip.webm", type:"video/webm"})).toBe(true);
  });
});

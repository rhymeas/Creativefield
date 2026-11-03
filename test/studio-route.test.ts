import { describe, expect, it } from "vitest";
import { studioRouteFromHash, studioRouteHash, videoHashPart, videoWorkflowHash } from "../src/ui/studio-route";

describe("studio hash routes", () => {
  it.each([
    ["#video", "video"],
    ["#motion", "motion"],
    ["#library", "library"],
    ["#catalogue", "catalogue"],
  ] as const)("maps %s to %s", (hash, route) => {
    expect(studioRouteFromHash(hash)).toBe(route);
    expect(studioRouteHash(route)).toBe(hash);
  });

  it.each(["", "#explore", "#audio", "#unknown"])("falls back unsupported hash %s to Video", (hash) => {
    expect(studioRouteFromHash(hash)).toBe("video");
  });

  /* An old `#video` link and a new `#video/camera` link both open the video studio. */
  it.each(["#video", "#video/camera", "#video/trim/abc", "#video/wan22-ti2v-5b"])("opens the video studio for %s", (hash) => {
    expect(studioRouteFromHash(hash)).toBe("video");
  });
});

describe("video workflow addresses", () => {
  it.each([
    ["#video/camera", "camera"],
    ["#video/wan22-ti2v-5b", "wan22-ti2v-5b"],
    ["#video/trim/abc", "trim"],
  ])("reads the workflow part of %s as %s", (hash, part) => {
    expect(videoHashPart(hash)).toBe(part);
  });

  it.each(["#video", "#video/", "#motion", "#image/camera", "", "#ds"])("reads no workflow part from %s", (hash) => {
    expect(videoHashPart(hash)).toBeUndefined();
  });

  it.each(["camera", "wan22-ti2v-5b", "wan22-flf2v-14b"])("writes and reads back %s", (id) => {
    expect(videoHashPart(videoWorkflowHash(id))).toBe(id);
  });
});

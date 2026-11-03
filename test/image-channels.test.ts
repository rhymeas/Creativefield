import { describe, expect, it } from "vitest";
import { channelPixels } from "../src/image/editor/channel-preview";

describe("channel preview pixels", () => {
  const source = new Uint8ClampedArray([230, 90, 15, 128, 10, 40, 200, 0]);
  it("preserves RGB and transparency without mutating the composite", () => {
    const rgb = channelPixels(source, "rgb");
    expect(rgb).toEqual(source);
    rgb[0] = 0;
    expect(source[0]).toBe(230);
  });
  it.each([ ["r", 230, 10], ["g", 90, 40], ["b", 15, 200], ["a", 128, 0] ] as const)("shows %s intensity as opaque grayscale", (channel, first, second) => {
    expect([...channelPixels(source, channel)]).toEqual([first, first, first, 255, second, second, second, 255]);
  });
});

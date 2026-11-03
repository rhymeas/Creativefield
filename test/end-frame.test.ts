import { describe, expect, it } from "vitest";
import { endFramePair, endFrameRoute, isEndFrameVariant, withOptionalEndImage } from "../src/team/end-frame";
import type { CapabilityManifestV2 } from "../src/capabilities/types";

const model = (id: string, ports: string[], local = "implemented") => ({
  id, version: "1.0.0", coverage: { local, hosted: "planned" },
  inputs: ports.map((port) => ({ id: port, label: port.replace("_", " "), type: "image", required: true })),
}) as unknown as CapabilityManifestV2;
const i2v = model("wan22-i2v-14b", ["start_image"]);
const flf = model("wan22-flf2v-14b", ["start_image", "end_image"]);

describe("optional end image", () => {
  it("pairs Wan 2.2 14B image to video with its first/last-frame sibling, and nothing else", () => {
    expect(endFramePair(i2v, [i2v, flf])).toBe(flf);
    expect(endFramePair(i2v, [i2v])).toBeUndefined();
    expect(endFramePair(i2v, [i2v, model("wan22-flf2v-14b", ["start_image", "end_image"], "planned")])).toBeUndefined();
    expect(endFramePair(model("wan22-ti2v-5b", ["start_image"]), [flf])).toBeUndefined();
    expect(isEndFrameVariant("wan22-flf2v-14b")).toBe(true);
    expect(isEndFrameVariant("wan22-i2v-14b")).toBe(false);
  });

  it("adds an end image the person may leave empty", () => {
    const shown = withOptionalEndImage(i2v, flf);
    expect(shown.inputs.map((port) => `${port.id}:${port.required}`)).toEqual(["start_image:true", "end_image:false"]);
    expect(shown.inputs[1].label).toBe("End image (optional)");
    expect(withOptionalEndImage(i2v, undefined)).toBe(i2v);
    expect(withOptionalEndImage(flf, flf)).toBe(flf);
  });

  it("runs image to video without an end image and first/last frame with one", () => {
    expect(endFrameRoute(i2v, flf, { start_image: "a" })).toEqual({ capabilityId: "wan22-i2v-14b", version: "1.0.0", inputs: { start_image: "a" } });
    expect(endFrameRoute(i2v, flf, { start_image: "a", end_image: "" })).toEqual({ capabilityId: "wan22-i2v-14b", version: "1.0.0", inputs: { start_image: "a" } });
    expect(endFrameRoute(i2v, flf, { start_image: "a", end_image: "b" })).toEqual({ capabilityId: "wan22-flf2v-14b", version: "1.0.0", inputs: { start_image: "a", end_image: "b" } });
    expect(endFrameRoute(flf, undefined, { start_image: "a", end_image: "b" })).toEqual({ capabilityId: "wan22-flf2v-14b", version: "1.0.0", inputs: { start_image: "a", end_image: "b" } });
  });
});

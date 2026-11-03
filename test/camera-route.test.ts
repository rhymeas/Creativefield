import { describe, expect, it } from "vitest";
import { cameraPair, cameraRoute, supportsH3PromptCamera } from "../src/team/camera-route";
import type { CapabilityManifestV2 } from "../src/capabilities/types";

const control = (id: string, extra: object = {}) => ({ id, label: id, type: "number", default: 1, binding: { node: "1", field: id }, ...extra });
const camera = {
  id: "camera", version: "0.2.0", coverage: { local: "implemented", hosted: "planned" }, inputs: [],
  controls: [
    control("prompt", { type: "string" }), control("camera_pose", { type: "select", options: ["Static", "Pan Left", "Zoom In"] }),
    control("speed", { max: 10 }), control("length", { max: 5 }), control("seed", { type: "integer" }),
    control("width", { min: 640, max: 640 }), control("height", { min: 640, max: 640 }),
  ],
} as unknown as CapabilityManifestV2;
const i2v = { id: "wan22-i2v-14b", version: "1", coverage: { local: "implemented", hosted: "planned" }, inputs: [], controls: [] } as unknown as CapabilityManifestV2;

describe("camera move on a fixed path", () => {
  it("pairs Wan 2.2 14B with the camera model only when that can run", () => {
    expect(cameraPair(i2v, [i2v, camera])).toBe(camera);
    expect(cameraPair(i2v, [i2v])).toBeUndefined();
    expect(cameraPair(camera, [camera])).toBeUndefined();
  });

  it("runs the move as the camera model's own pose, with only the controls it has", () => {
    const run = cameraRoute(camera, "pan-left", { start_image: "a1", end_image: "x" }, { prompt: "a harbour", length: 8, seed: 7, width: 1280, motion_prompt: "x" });
    expect(run).toMatchObject({ capabilityId: "camera", inputs: { start_image: "a1" }, controls: { prompt: "a harbour", camera_pose: "Pan Left", length: 5, seed: 7 } });
    expect(run?.controls).not.toHaveProperty("width");
    expect(run?.controls).not.toHaveProperty("motion_prompt");
  });

  it("does nothing without a start image or for a move the model lacks", () => {
    expect(cameraRoute(camera, "pan-left", {}, {})).toBeUndefined();
    expect(cameraRoute(camera, "pan-up", { start_image: "a1" }, {})).toBeUndefined();
  });
});

describe("H3 prompt camera controls", () => {
  it("only enables prompt guidance for H3 creation workflows with a bound prompt", () => {
    for (const id of ["h3-t2v", "h3-i2v", "h3-flf2v"]) {
      expect(supportsH3PromptCamera({ ...camera, id })).toBe(true);
      expect(supportsH3PromptCamera({ ...camera, id, controls: [] })).toBe(false);
    }
    expect(supportsH3PromptCamera(camera)).toBe(false);
    expect(cameraPair({ ...camera, id: "h3-i2v" }, [camera])).toBeUndefined();
  });
});

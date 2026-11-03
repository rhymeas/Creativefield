import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { ApiGraph } from "../src/workflow/build";
import {
  JUTSU_MAX_FRAMES,
  JUTSU_OVERLAP_FRAMES,
  JUTSU_WINDOW_FRAMES,
  compileJutsuRelay,
  planJutsuRelay,
  type JutsuRelayPlan,
} from "../src/capabilities/jutsu";
import { validateCapability } from "../src/capabilities/validate";
import type { CapabilityManifestV2 } from "../src/capabilities/types";

const packTemplate = () => JSON.parse(readFileSync("native-workflows/local-jutsu-replace/template.api.json", "utf8")) as ApiGraph;
const packManifest = () => JSON.parse(readFileSync("native-workflows/local-jutsu-replace/manifest.json", "utf8")) as CapabilityManifestV2;

describe("local jutsu relay plan", () => {
  it("uses the window Wan Animate 2 was trained at and one repeated seam frame", () => {
    expect([JUTSU_WINDOW_FRAMES, JUTSU_OVERLAP_FRAMES]).toEqual([81, 1]);
    expect(JUTSU_MAX_FRAMES).toBe(161);
  });

  it("covers every frame it can reach, up to the ceiling", () => {
    for (let frames = 1; frames <= JUTSU_MAX_FRAMES; frames += 1) {
      const plan = planJutsuRelay(frames);
      const emitted = plan.windows.reduce((total, window) => total + window.emittedFrames, 0);
      expect(emitted).toBe(plan.emittedFrames);
      expect(emitted - plan.tailTrim).toBe(frames);
      expect(plan.windowCount).toBe(plan.windows.length);
      // The crop never asks for more frames than the windows produce, and never loses more than three.
      expect(plan.outputFrames).toBe(Math.min(frames, plan.emittedFrames));
      expect(frames - plan.outputFrames).toBeLessThanOrEqual(3);
    }
  });

  it("relays two windows for a clip longer than one, and one window for a shorter clip", () => {
    expect(planJutsuRelay(81).windowCount).toBe(1);
    // A 4n+1 tail can leave a frame or three out of reach; the plan says so instead of pretending.
    const short = planJutsuRelay(82);
    expect([short.windowCount, short.outputFrames, short.tailTrim]).toEqual([1, 81, -1]);
    expect(planJutsuRelay(157).windowCount).toBe(2);
    const plan = planJutsuRelay(157);
    expect(plan.windows.map((window) => [window.startFrame, window.generatedFrames, window.overlapFrames])).toEqual([[0, 81, 0], [81, 77, 1]]);
    expect([plan.outputFrames, plan.tailTrim]).toEqual([157, 0]);
  });

  it("stops at its ceiling instead of running a third window", () => {
    const plan = planJutsuRelay(JUTSU_MAX_FRAMES);
    expect(plan.windowCount).toBe(2);
    expect([plan.outputFrames, plan.tailTrim]).toEqual([161, 0]);
  });

  it("refuses a clip it cannot reach and a count that is not a whole number", () => {
    expect(() => planJutsuRelay(JUTSU_MAX_FRAMES + 1)).toThrow(/at most 2 relay windows/);
    expect(() => planJutsuRelay(0)).toThrow(/positive safe integer/);
    expect(() => planJutsuRelay(12.5)).toThrow(/positive safe integer/);
  });
});

describe("local jutsu relay compile", () => {
  it("binds a clip that fits one window to the reviewed single window", () => {
    const graph = compileJutsuRelay(packTemplate(), planJutsuRelay(81));
    expect(graph["261:247"].inputs.length).toBe(81);
    expect(graph["crop"].inputs.length).toBe(81);
    expect(graph["maskSlice"].inputs.length).toBe(81);
    expect(Object.keys(graph).some((id) => id.startsWith("w1:"))).toBe(false);
    expect(graph["289"].inputs["images.image1"]).toBeUndefined();
    expect(graph["289"].inputs["images.image0"]).toEqual(["261:299", 0]);
  });

  it("keeps both windows for a longer clip and crops to the clip's own length", () => {
    const graph = compileJutsuRelay(packTemplate(), planJutsuRelay(157));
    expect(graph["261:247"].inputs.length).toBe(81);
    expect(graph["w1:247"].inputs.length).toBe(77);
    expect(graph["crop"].inputs.length).toBe(157);
    expect(graph["289"].inputs["images.image1"]).toEqual(["w1:299", 0]);
  });

  it("gives the second window the run's seed, not the template's", () => {
    const base = packTemplate();
    base["261:19"].inputs.noise_seed = 7;
    base["w1:19"].inputs.noise_seed = 714297762067883;
    expect(compileJutsuRelay(base, planJutsuRelay(157))["w1:19"].inputs.noise_seed).toBe(7);
  });

  it("rejects a plan that no longer matches its frame count", () => {
    const plan = planJutsuRelay(157);
    expect(() => compileJutsuRelay(packTemplate(), { ...plan } as JutsuRelayPlan)).toThrow(/frozen plan/);
    expect(() => compileJutsuRelay(packTemplate(), Object.freeze({ ...plan, windowCount: 1 }) as JutsuRelayPlan)).toThrow(/plan field: windowCount/);
  });

  it("rejects a graph whose relay or composite wiring drifted", () => {
    const wrongContinuation = packTemplate();
    wrongContinuation["w1:247"].inputs.continue_motion = ["261:247", 0];
    expect(() => compileJutsuRelay(wrongContinuation, planJutsuRelay(157))).toThrow(/w1:247.continue_motion/);

    const wrongSource = packTemplate();
    wrongSource["compose"].inputs.destination = ["261:243", 0];
    expect(() => compileJutsuRelay(wrongSource, planJutsuRelay(157))).toThrow(/compose.destination/);

    const unreviewed = packTemplate();
    unreviewed["extra"] = { class_type: "PreviewImage", inputs: { images: ["crop", 0] } };
    expect(() => compileJutsuRelay(unreviewed, planJutsuRelay(157))).toThrow(/Comparison or preview node/);
  });

  it("ships a manifest the catalogue accepts, with the relay contract and its inputs", () => {
    const manifest = packManifest();
    expect(manifest.replaceContract).toEqual({
      kind: "jutsu_relay_v1", sourceInput: "source_video", artifactNode: "246", maxWindows: 1,
    });
    expect(manifest.inputs.map((port) => port.id)).toEqual(["source_video", "character_image"]);
    expect(manifest.audioPolicies).toEqual(["mute"]);
    expect(validateCapability({ manifest, template: packTemplate() })).toEqual([]);
  });

  it("refuses a clip longer than the windows the pack was run with", () => {
    expect(planJutsuRelay(81, 1).windowCount).toBe(1);
    expect(() => planJutsuRelay(82, 1)).toThrow(/at most 1 relay window \(81 frames\)/);
    expect(planJutsuRelay(157, 2).windowCount).toBe(2);
    expect(() => planJutsuRelay(162, 2)).toThrow(/at most 2 relay windows \(161 frames\)/);
  });
});

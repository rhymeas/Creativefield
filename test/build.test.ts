import { describe, expect, it } from "vitest";
import fixtureTemplate from "./fixtures/fixture_i2v_api.json";
import fixtureManifest from "./fixtures/fixture-manifest.json";
import { buildGraph, secondsToWanFrames, type ApiGraph } from "../src/workflow/build";
import { validateManifest, type Manifest } from "../src/workflow/manifest";

const template = fixtureTemplate as ApiGraph;
const manifest = fixtureManifest as Manifest;

const params = {
  prompt: "a cat turns its head",
  negative: "blurry",
  startImage: "upload.png",
  resolution: "landscape",
  durationSec: 5,
  seed: 42,
};

describe("secondsToWanFrames", () => {
  it("returns 4n+1 frame counts", () => {
    for (const s of [1, 2, 3, 4, 5]) {
      expect((secondsToWanFrames(s, 16) - 1) % 4).toBe(0);
    }
  });

  it("gives 81 frames for 5 seconds at 16 fps", () => {
    expect(secondsToWanFrames(5, 16)).toBe(81);
  });
});

describe("buildGraph", () => {
  it("writes every UI value into its bound field", () => {
    const g = buildGraph(template, manifest, params);
    expect(g["1"].inputs.text).toBe("a cat turns its head");
    expect(g["2"].inputs.text).toBe("blurry");
    expect(g["4"].inputs.image).toBe("upload.png");
    expect(g["5"].inputs.width).toBe(832);
    expect(g["5"].inputs.height).toBe(480);
    expect(g["5"].inputs.length).toBe(81);
    expect(g["3"].inputs.seed).toBe(42);
  });

  it("does not mutate the template", () => {
    const before = JSON.stringify(template);
    buildGraph(template, manifest, params);
    expect(JSON.stringify(template)).toBe(before);
  });

  it("keeps the template's own negative prompt when the negative is empty", () => {
    const withDefault = structuredClone(template);
    withDefault["2"].inputs.text = "template default";
    const g = buildGraph(withDefault, manifest, { ...params, negative: "  " });
    expect(g["2"].inputs.text).toBe("template default");
  });

  it("uses portrait dimensions when asked", () => {
    const g = buildGraph(template, manifest, { ...params, resolution: "portrait" });
    expect(g["5"].inputs.width).toBe(480);
    expect(g["5"].inputs.height).toBe(832);
  });

  it("rejects durations outside the model limits", () => {
    expect(() => buildGraph(template, manifest, { ...params, durationSec: 9 })).toThrow(/Duration/);
  });

  it("rejects unknown resolutions", () => {
    expect(() => buildGraph(template, manifest, { ...params, resolution: "8k" })).toThrow(/resolution/);
  });
});

describe("validateManifest", () => {
  it("passes for a fully bound manifest", () => {
    expect(validateManifest(manifest, template)).toEqual([]);
  });

  it("reports unset node IDs", () => {
    const unset = structuredClone(manifest);
    for (const binding of Object.values(unset.inputs)) binding.node = null;
    unset.outputs.video.node = null;
    const problems = validateManifest(unset, template);
    expect(problems.length).toBe(Object.keys(unset.inputs).length + 1);
    expect(problems.every((p) => /node ID is not set/.test(p.message))).toBe(true);
  });

  it("reports a binding to a missing field", () => {
    const bad = structuredClone(manifest);
    bad.inputs.prompt.field = "no_such_input";
    const problems = validateManifest(bad, template);
    expect(problems.map((p) => p.path)).toContain("inputs.prompt");
  });
});

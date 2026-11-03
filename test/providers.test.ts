import { describe, expect, it } from "vitest";
import { loadProviders, providers, providersFor } from "../src/pipelines/registry";
import { buildGraph } from "../src/workflow/build";
import { validateManifest } from "../src/workflow/manifest";

describe("provider registry", () => {
  it("finds the Wan 2.2 TI2V 5B image-to-video provider", () => {
    const p = providersFor("i2v").find((x) => x.id === "wan22-ti2v-5b");
    expect(p).toBeDefined();
    expect(p!.pipeline).toBe("i2v");
  });

  it("fails when a provider folder has no template", () => {
    expect(() => loadProviders({ "../../pipelines/i2v/x/manifest.json": { id: "x" } }, {})).toThrow(/no template/);
  });

  describe.each(providers.map((p) => [p.id, p] as const))("%s", (_id, provider) => {
    it("has a manifest whose bindings all point at real nodes and fields", () => {
      expect(validateManifest(provider.manifest, provider.template)).toEqual([]);
    });

    it("builds a graph for a typical job without touching the template", () => {
      const before = JSON.stringify(provider.template);
      const res = Object.keys(provider.manifest.limits.resolutions)[0];
      const g = buildGraph(provider.template, provider.manifest, {
        prompt: "a test prompt",
        negative: "",
        startImage: "input.png",
        endImage: "end.png",
        motionVideo: "drive.mp4",
        motionPrompt: "a person dancing",
        resolution: res,
        durationSec: 2,
        seed: 123,
      });
      const m = provider.manifest;
      expect(g[m.inputs.prompt.node!].inputs[m.inputs.prompt.field]).toBe("a test prompt");
      if (m.inputs.start_image) {
        expect(g[m.inputs.start_image.node!].inputs[m.inputs.start_image.field]).toBe("input.png");
      }
      if (m.inputs.motion_video) {
        expect(g[m.inputs.motion_video.node!].inputs[m.inputs.motion_video.field]).toBe("drive.mp4");
      }
      if (m.inputs.end_image) {
        expect(g[m.inputs.end_image.node!].inputs[m.inputs.end_image.field]).toBe("end.png");
      }
      expect(g[m.inputs.seed.node!].inputs[m.inputs.seed.field]).toBe(123);
      expect(JSON.stringify(provider.template)).toBe(before);
    });

    it("lists the model files it needs", () => {
      expect(provider.manifest.requires?.models.length).toBeGreaterThan(0);
    });

    it("declares that the bundled graph uses native ComfyUI execution", () => {
      expect(provider.manifest.execution).toEqual({ route: "native-comfy" });
    });
  });

  it("Wan 2.2 5B uses 24 fps, so 5 s is 121 frames", () => {
    const p = providers.find((x) => x.id === "wan22-ti2v-5b")!;
    const g = buildGraph(p.template, p.manifest, {
      prompt: "x", negative: "", startImage: "a.png", resolution: "landscape", durationSec: 5, seed: 1,
    });
    expect(g["55"].inputs).toMatchObject({ width: 1280, height: 704, length: 121 });
  });
});

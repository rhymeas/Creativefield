import { describe, expect, it } from "vitest";
import { providers, providersFor } from "../src/pipelines/registry";
import { matchProvider, readParams } from "../src/pipelines/recover";
import { buildGraph } from "../src/workflow/build";
import { jobFromHistory } from "../src/jobs/server";
import { explainPromptError } from "../src/workflow/prompt-errors";
import type { HistoryEntry } from "../src/comfy/client";

const flf = providersFor("flf2v").find((p) => p.id === "wan22-flf2v-14b")!;
const i2v14 = providersFor("i2v").find((p) => p.id === "wan22-i2v-14b")!;
const params = { prompt: "dusk turns to night", negative: "", resolution: "landscape", durationSec: 3, seed: 5 };

describe("first-and-last-frame provider", () => {
  it("shares its model family and files with the 14B image-to-video provider", () => {
    expect(flf).toBeDefined();
    expect(flf.pipeline).toBe("flf2v");
    expect(flf.manifest.family).toBe(i2v14.manifest.family);
    expect(flf.manifest.requires).toEqual(i2v14.manifest.requires);
  });

  it("has both a start and an end image input, pointing at different nodes", () => {
    const { start_image, end_image } = flf.manifest.inputs;
    expect(start_image?.node).toBeTruthy();
    expect(end_image?.node).toBeTruthy();
    expect(start_image!.node).not.toBe(end_image!.node);
  });

  it("follows the template's wiring: the start input is fed by the node the manifest calls start_image", () => {
    const latent = flf.template["67"].inputs;
    expect(latent.start_image).toEqual([flf.manifest.inputs.start_image!.node, 0]);
    expect(latent.end_image).toEqual([flf.manifest.inputs.end_image!.node, 0]);
  });

  it("writes both images into the graph, and 3 s at 16 fps becomes 49 frames", () => {
    const g = buildGraph(flf.template, flf.manifest, { ...params, startImage: "a.png", endImage: "b.png" });
    expect(g["68"].inputs.image).toBe("a.png");
    expect(g["62"].inputs.image).toBe("b.png");
    expect(g["67"].inputs).toMatchObject({ width: 832, height: 480, length: 49 });
    expect(g["6"].inputs.text).toBe("dusk turns to night");
  });

  it("refuses to build without an end image, or without a start image", () => {
    expect(() => buildGraph(flf.template, flf.manifest, { ...params, startImage: "a.png" })).toThrow(/end image/);
    expect(() => buildGraph(flf.template, flf.manifest, { ...params, endImage: "b.png" })).toThrow(/start image/);
  });

  it("is told apart from the 14B image-to-video graph, and recovers both images from history", () => {
    const g = buildGraph(flf.template, flf.manifest, { ...params, startImage: "a.png", endImage: "b.png" });
    expect(matchProvider(g, providers)?.id).toBe("wan22-flf2v-14b");
    expect(readParams(g, flf.manifest)).toMatchObject({ startImage: "a.png", endImage: "b.png", durationSec: 3, aspect: "landscape" });

    const entry: HistoryEntry = {
      prompt: [1, "job", g, { create_time: 1 }, ["61"]],
      outputs: { "61": { images: [{ filename: "v.mp4", subfolder: "video", type: "output" }] } },
      status: { status_str: "success", messages: [] },
    };
    const job = jobFromHistory("job", entry, providers)!;
    expect(job).toMatchObject({
      providerId: "wan22-flf2v-14b",
      status: "done",
      thumb: { kind: "input", filename: "a.png" },
      endThumb: { kind: "input", filename: "b.png" },
      stages: 2,
    });
  });

  it("names a missing end image 'End image' in rejection messages", () => {
    const e = explainPromptError(
      { node_errors: { "62": { class_type: "LoadImage", errors: [{ type: "required_input_missing", message: "x", extra_info: { input_name: "image" } }] } } },
      flf.manifest,
      flf.template,
    );
    expect(e.lines).toEqual(["End image is missing."]);
  });
});

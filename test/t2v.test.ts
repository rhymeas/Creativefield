import { describe, expect, it } from "vitest";
import { providers, providersFor } from "../src/pipelines/registry";
import { matchProvider, readParams } from "../src/pipelines/recover";
import { buildGraph } from "../src/workflow/build";
import { jobFromHistory } from "../src/jobs/server";
import type { HistoryEntry } from "../src/comfy/client";

const i2v = providersFor("i2v").find((p) => p.id === "wan22-ti2v-5b")!;
const t2v = providersFor("t2v").find((p) => p.id === "wan22-ti2v-5b-t2v")!;

const params = { prompt: "a lighthouse in a storm", negative: "", resolution: "landscape", durationSec: 3, seed: 5 };

describe("text-to-video provider", () => {
  it("is found in the t2v pipeline and shares its model with the image-to-video provider", () => {
    expect(t2v).toBeDefined();
    expect(t2v.pipeline).toBe("t2v");
    expect(t2v.manifest.family).toBe(i2v.manifest.family);
    expect(t2v.manifest.requires).toEqual(i2v.manifest.requires);
  });

  it("has no start-image input, and its template has no image loader", () => {
    expect(t2v.manifest.inputs.start_image).toBeUndefined();
    expect(Object.values(t2v.template).some((n) => n.class_type === "LoadImage")).toBe(false);
  });

  it("builds a graph without a start image and sends no image to the latent node", () => {
    const g = buildGraph(t2v.template, t2v.manifest, params);
    expect(g["6"].inputs.text).toBe("a lighthouse in a storm");
    expect(g["55"].inputs).toMatchObject({ width: 1280, height: 704, length: 73 });
    expect(g["55"].inputs).not.toHaveProperty("start_image");
  });

  it("makes the image-to-video provider insist on a start image", () => {
    expect(() => buildGraph(i2v.template, i2v.manifest, params)).toThrow(/start image/);
  });
});

describe("telling the two pipelines apart", () => {
  it("matches each graph to its own provider", () => {
    const t = buildGraph(t2v.template, t2v.manifest, params);
    const i = buildGraph(i2v.template, i2v.manifest, { ...params, startImage: "a.png" });
    expect(matchProvider(t, providers)?.id).toBe("wan22-ti2v-5b-t2v");
    expect(matchProvider(i, providers)?.id).toBe("wan22-ti2v-5b");
  });

  it("recovers a text-to-video job with no start image and no thumbnail", () => {
    const graph = buildGraph(t2v.template, t2v.manifest, params);
    expect(readParams(graph, t2v.manifest)).toMatchObject({ prompt: "a lighthouse in a storm", startImage: "", durationSec: 3, seed: 5 });

    const entry: HistoryEntry = {
      prompt: [1, "job", graph, { create_time: 1 }, ["58"]],
      outputs: { "58": { images: [{ filename: "v.mp4", subfolder: "video", type: "output" }] } },
      status: { status_str: "success", messages: [] },
    };
    const job = jobFromHistory("job", entry, providers)!;
    expect(job).toMatchObject({ providerId: "wan22-ti2v-5b-t2v", status: "done", thumb: null });
  });
});

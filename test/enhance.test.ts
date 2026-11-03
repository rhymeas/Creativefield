import { describe, expect, it } from "vitest";
import { enhancers, loadEnhancers, providers } from "../src/pipelines/registry";
import { matchProvider } from "../src/pipelines/recover";
import { buildEnhanceGraph, factorFits, matchEnhancer, readEnhanceParams } from "../src/workflow/enhance";
import { buildGraph } from "../src/workflow/build";
import { validateEnhanceManifest } from "../src/workflow/manifest";
import { checkReadiness } from "../src/workflow/readiness";
import { jobFromHistory, jobsFromQueue } from "../src/jobs/server";
import type { HistoryEntry, RawQueueItem } from "../src/comfy/client";
import type { ObjectInfo } from "../src/workflow/ui-to-api";
import infoJson from "./fixtures/object_info.enhance.json";

const up = enhancers.find((e) => e.id === "realesrgan-x4")!;
const wan = providers.find((p) => p.id === "wan22-ti2v-5b")!;

describe("enhancer registry", () => {
  it("loads the upscaler as an enhancer and keeps it out of the generation providers", () => {
    expect(up).toBeDefined();
    expect(up.pipeline).toBe("enhance");
    expect(providers.some((p) => p.id === up.id)).toBe(false);
    expect(enhancers.some((e) => e.id === wan.id)).toBe(false);
  });

  it("has bindings that point at real nodes and fields", () => {
    expect(validateEnhanceManifest(up.manifest, up.template)).toEqual([]);
  });

  it("declares that the bundled graph uses native ComfyUI execution", () => {
    expect(up.manifest.execution).toEqual({ route: "native-comfy" });
  });

  it("fails when an enhancer folder has no template", () => {
    expect(() => loadEnhancers({ "../../pipelines/enhance/x/manifest.json": { id: "x", kind: "enhance" } }, {})).toThrow(/no template/);
  });
});

describe("buildEnhanceGraph", () => {
  it("2x asks the scale node for 0.5 and 4x for 1, because the model already enlarges by 4", () => {
    expect(buildEnhanceGraph(up.template, up.manifest, { sourceVideo: "a.mp4", factor: 2 })["5"].inputs.scale_by).toBe(0.5);
    expect(buildEnhanceGraph(up.template, up.manifest, { sourceVideo: "a.mp4", factor: 4 })["5"].inputs.scale_by).toBe(1);
  });

  it("writes the clip name and leaves the template alone", () => {
    const before = JSON.stringify(up.template);
    const g = buildEnhanceGraph(up.template, up.manifest, { sourceVideo: "clip-1.mp4", factor: 2 });
    expect(g["1"].inputs.file).toBe("clip-1.mp4");
    expect(JSON.stringify(up.template)).toBe(before);
  });

  it("refuses a factor the enhancer does not offer", () => {
    expect(() => buildEnhanceGraph(up.template, up.manifest, { sourceVideo: "a.mp4", factor: 3 })).toThrow(/2x and 4x/);
  });

  it("reads the clip and factor back out of a graph", () => {
    const g = buildEnhanceGraph(up.template, up.manifest, { sourceVideo: "clip-1.mp4", factor: 4 });
    expect(readEnhanceParams(g, up.manifest)).toEqual({ sourceVideo: "clip-1.mp4", factor: 4 });
  });
});

describe("factorFits", () => {
  it("offers 4x for a 832x480 clip but not for a 1280x704 one, whose result H.264 cannot hold", () => {
    expect(factorFits(up.manifest, { width: 832, height: 480 }, 4)).toBe(true); // 3328 px
    expect(factorFits(up.manifest, { width: 1280, height: 704 }, 4)).toBe(false); // 5120 px
    expect(factorFits(up.manifest, { width: 1280, height: 704 }, 2)).toBe(true); // 2560 px
  });
});

describe("telling enhance graphs from generation graphs", () => {
  const enhanceGraph = buildEnhanceGraph(up.template, up.manifest, { sourceVideo: "c.mp4", factor: 2 });
  const generationGraph = buildGraph(wan.template, wan.manifest, { prompt: "x", negative: "", startImage: "a.png", resolution: "landscape", durationSec: 2, seed: 1 });

  it("matches each graph only to its own kind", () => {
    expect(matchEnhancer(enhanceGraph, enhancers)?.id).toBe("realesrgan-x4");
    expect(matchProvider(enhanceGraph, providers)).toBeUndefined();
    expect(matchEnhancer(generationGraph, enhancers)).toBeUndefined();
  });
});

describe("enhance jobs from ComfyUI history and queue", () => {
  const graph = buildEnhanceGraph(up.template, up.manifest, { sourceVideo: "clip-1.mp4", factor: 2 });
  const sourceParams = { prompt: "dusk to night", negative: "", startImage: "a.png", aspect: "landscape", durationSec: 3, seed: 9 };
  const item = (studio?: unknown): RawQueueItem => [4, "enh-1", graph, { create_time: 7000, ...(studio ? { studio } : {}) }, ["7"]];
  const entry = (studio?: unknown): HistoryEntry => ({
    prompt: item(studio),
    outputs: {
      "1": { images: [{ filename: "clip-1.mp4", subfolder: "", type: "input" }] },
      "7": { images: [{ filename: "up_00001_.mp4", subfolder: "video", type: "output" }] },
    },
    status: { status_str: "success", messages: [["execution_start", { timestamp: 1000 }], ["execution_success", { timestamp: 41000 }]] },
  });

  it("recovers an upscale made by the studio, with the clip it came from", () => {
    const job = jobFromHistory("enh-1", entry({ kind: "enhance", sourceJobId: "gen-9", sourceParams }), providers, enhancers)!;
    expect(job).toMatchObject({
      kind: "enhance",
      status: "done",
      model: "Real-ESRGAN 2×",
      resolution: "2× larger",
      params: sourceParams,
      enhance: { factor: 2, sourceVideo: "clip-1.mp4", sourceJobId: "gen-9" },
      runMs: 40000,
    });
    // The loader node also reports the input clip as an output; the saved result is node 7.
    expect(job.output).toEqual({ filename: "up_00001_.mp4", subfolder: "video", type: "output" });
  });

  it("recovers an upscale made some other way, without the original prompt", () => {
    const job = jobFromHistory("enh-1", entry(), providers, enhancers)!;
    expect(job).toMatchObject({ kind: "enhance", status: "done", params: { prompt: "", durationSec: 0 } });
  });

  it("ignores enhance jobs when no enhancer is known", () => {
    expect(jobFromHistory("enh-1", entry(), providers)).toBeUndefined();
  });

  it("shows a running and a pending upscale from the queue", () => {
    const jobs = jobsFromQueue({ queue_running: [item()], queue_pending: [[5, "enh-2", graph, { create_time: 8000 }, ["7"]]] }, providers, enhancers);
    expect(jobs.map((j) => [j.id, j.kind, j.status, j.queuePosition])).toEqual([
      ["enh-1", "enhance", "running", null],
      ["enh-2", "enhance", "queued", 1],
    ]);
  });
});

describe("upscaler readiness", () => {
  const info = (withModel: boolean): ObjectInfo => {
    const i = structuredClone(infoJson) as unknown as ObjectInfo;
    const spec = i.UpscaleModelLoader.input.required!.model_name as unknown as [string[]];
    spec[0] = withModel ? ["RealESRGAN_x4plus.pth"] : ["other.pth"];
    // The fixture keeps only the first few options of each dropdown; the template uses "lanczos".
    (i.ImageScaleBy.input.required!.upscale_method as unknown as [string[]])[0] = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"];
    return i;
  };

  it("is ready when the model file is installed", () => {
    expect(checkReadiness(up, info(true)).state).toBe("ready");
  });

  it("reports the missing model file with its folder", () => {
    const r = checkReadiness(up, info(false));
    expect(r.state).toBe("missing_models");
    expect(r.missingFiles).toEqual([{ folder: "upscale_models", file: "RealESRGAN_x4plus.pth" }]);
  });
});

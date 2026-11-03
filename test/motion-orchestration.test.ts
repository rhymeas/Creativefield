import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WAN_ANIMATE_CHUNK_FRAMES,
  WAN_ANIMATE_FINAL_CROP_NODE_ID,
  WAN_ANIMATE_MAX_CHUNKS,
  WAN_ANIMATE_MAX_DESIRED_FRAMES,
  WAN_ANIMATE_OVERLAP_FRAMES,
  WAN_ANIMATE_UNIQUE_FRAMES_PER_CHUNK,
  compileWanAnimateMotion,
  planWanAnimateFrames,
} from "../src/capabilities/motion";
import { providersFor } from "../src/pipelines/registry";
import { buildGraph, type ApiGraph } from "../src/workflow/build";

const provider = providersFor("motion").find((candidate) => candidate.id === "wan-animate2-distilled")!;
const segmentSuffixes = [
  "3", "4", "6", "7", "9", "18", "19", "27", "75", "76", "95", "220", "222", "223",
  "224", "236", "239", "241", "243", "244", "247", "256", "257", "258", "297", "298", "299",
] as const;

function parameterizedGraph(): ApiGraph {
  return buildGraph(provider.template, provider.manifest, {
    prompt: "Character appearance: compiler sentinel character. Background: compiler sentinel set.",
    negative: "compiler sentinel negative",
    motionPrompt: "compiler sentinel motion",
    resolution: "portrait",
    durationSec: 0,
    seed: 987_654_321,
    startImage: "compiler-character.png",
    motionVideo: "compiler-drive.mp4",
  });
}

function remapSegmentReferences(value: unknown, ordinal: number): unknown {
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === "string" && value[0].startsWith("261:")) {
      return [`motion:${ordinal}:${value[0].slice(4)}`, value[1]];
    }
    return value.map((entry) => remapSegmentReferences(entry, ordinal));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, remapSegmentReferences(entry, ordinal)]),
    );
  }
  return value;
}

function findFinalCrop(graph: ApiGraph) {
  return Object.entries(graph).filter(([, node]) =>
    node.class_type === "ImageFromBatch" &&
    Array.isArray(node.inputs.image) &&
    node.inputs.image[0] === "289",
  );
}

describe("Wan Animate frame planning", () => {
  it("publishes the reviewed 81/1/80 bounded constants", () => {
    expect({
      chunkFrames: WAN_ANIMATE_CHUNK_FRAMES,
      overlapFrames: WAN_ANIMATE_OVERLAP_FRAMES,
      uniqueFrames: WAN_ANIMATE_UNIQUE_FRAMES_PER_CHUNK,
      maxChunks: WAN_ANIMATE_MAX_CHUNKS,
      maxFrames: WAN_ANIMATE_MAX_DESIRED_FRAMES,
    }).toEqual({ chunkFrames: 81, overlapFrames: 1, uniqueFrames: 80, maxChunks: 8, maxFrames: 641 });
  });

  it.each([
    [1, 1, 81, 80, [1]],
    [80, 1, 81, 1, [80]],
    [81, 1, 81, 0, [81]],
    [82, 2, 161, 79, [81, 1]],
    [160, 2, 161, 1, [81, 79]],
    [161, 2, 161, 0, [81, 80]],
    [162, 3, 241, 79, [81, 80, 1]],
    [641, 8, 641, 0, [81, 80, 80, 80, 80, 80, 80, 80]],
  ])("plans %i requested frames", (desiredFrames, chunkCount, generatedFrames, tailTrimFrames, emittedFrames) => {
    const plan = planWanAnimateFrames(desiredFrames);

    expect(plan).toMatchObject({
      desiredFrames,
      chunkFrames: 81,
      overlapFrames: 1,
      uniquePerChunk: 80,
      chunkCount,
      generatedFrames,
      tailTrimFrames,
    });
    expect(plan.chunks.map((chunk) => chunk.startFrame)).toEqual(
      Array.from({ length: chunkCount }, (_, ordinal) => ordinal * 80),
    );
    expect(plan.chunks.map((chunk) => chunk.generatedFrames)).toEqual(Array(chunkCount).fill(81));
    expect(plan.chunks.map((chunk) => chunk.overlapFrames)).toEqual([0, ...Array(chunkCount - 1).fill(1)]);
    expect(plan.chunks.map((chunk) => chunk.emittedFrames)).toEqual(emittedFrames);
    expect(plan.chunks.reduce((sum, chunk) => sum + chunk.emittedFrames, 0)).toBe(desiredFrames);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 642, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid or over-limit frame count %s",
    (frames) => expect(() => planWanAnimateFrames(frames)).toThrow(),
  );

  it("returns a deeply frozen, deterministic plan", () => {
    const first = planWanAnimateFrames(162);
    const second = planWanAnimateFrames(162);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.chunks)).toBe(true);
    expect(first.chunks.every(Object.isFrozen)).toBe(true);
    expect(() => { (first as { desiredFrames: number }).desiredFrames = 1; }).toThrow();
    expect(() => { (first.chunks[0] as { emittedFrames: number }).emittedFrames = 0; }).toThrow();
  });
});

describe("Wan Animate pure graph compilation", () => {
  it("uses the pinned reviewed source template unchanged", () => {
    const templateBytes = readFileSync(
      new URL("../pipelines/motion/wan-animate2-distilled/template.api.json", import.meta.url),
    );
    expect(createHash("sha256").update(templateBytes).digest("hex").toUpperCase()).toBe(
      "2049CE8290242D0731162201BEBC62C9B9ACF5C83AC2F6836841D9D11B47DD64",
    );
  });

  it("is deterministic and leaves the parameterized source graph and plan unchanged", () => {
    const base = parameterizedGraph();
    const plan = planWanAnimateFrames(162);
    const baseBefore = structuredClone(base);
    const planBefore = structuredClone(plan);

    const first = compileWanAnimateMotion(base, plan);
    const second = compileWanAnimateMotion(base, plan);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(base).toEqual(baseBefore);
    expect(plan).toEqual(planBefore);
  });

  it("keeps chunk zero anchors and creates exact deterministic IDs for later chunks", () => {
    const graph = compileWanAnimateMotion(parameterizedGraph(), planWanAnimateFrames(162));

    for (const suffix of segmentSuffixes) {
      expect(graph[`261:${suffix}`], `chunk zero ${suffix}`).toBeDefined();
      expect(graph[`motion:1:${suffix}`], `chunk one ${suffix}`).toBeDefined();
      expect(graph[`motion:2:${suffix}`], `chunk two ${suffix}`).toBeDefined();
      expect(graph[`motion:3:${suffix}`]).toBeUndefined();
    }
  });

  it("chains raw decoded frames and Wan output 5 while trimming seams only after chunk zero", () => {
    const graph = compileWanAnimateMotion(parameterizedGraph(), planWanAnimateFrames(162));

    expect(graph["261:247"].inputs).not.toHaveProperty("continue_motion");
    expect(graph["261:247"].inputs.video_frame_offset).toBe(0);
    expect(graph["261:297"].inputs.value).toBe(false);

    for (const ordinal of [1, 2]) {
      const previousPrefix = ordinal === 1 ? "261" : `motion:${ordinal - 1}`;
      const prefix = `motion:${ordinal}`;
      expect(graph[`${prefix}:247`].inputs.continue_motion).toEqual([`${previousPrefix}:6`, 0]);
      expect(graph[`${prefix}:247`].inputs.video_frame_offset).toEqual([`${previousPrefix}:247`, 5]);
      expect(graph[`${prefix}:297`].inputs.value).toBe(true);
      expect(graph[`${prefix}:298`].inputs).toMatchObject({
        image: [`${prefix}:6`, 0],
        batch_index: 1,
      });
      expect(graph[`${prefix}:299`].inputs.on_true).toEqual([`${prefix}:298`, 0]);
      expect(graph[`${prefix}:299`].inputs.on_false).toEqual([`${prefix}:6`, 0]);
    }
  });

  it("keeps every chunk at 81 frames and trims each chunk's own latent output", () => {
    const graph = compileWanAnimateMotion(parameterizedGraph(), planWanAnimateFrames(162));

    for (const prefix of ["261", "motion:1", "motion:2"]) {
      expect(graph[`${prefix}:247`].inputs.length).toBe(81);
      expect(graph[`${prefix}:223`].inputs.samples).toEqual([`${prefix}:19`, 0]);
      expect(graph[`${prefix}:223`].inputs.trim_amount).toEqual([`${prefix}:247`, 3]);
    }
  });

  it("aggregates contiguous chunk outputs and crops the result to exactly F", () => {
    const desiredFrames = 160;
    const graph = compileWanAnimateMotion(parameterizedGraph(), planWanAnimateFrames(desiredFrames));

    expect(graph["289"].inputs).toEqual({
      "images.image0": ["261:299", 0],
      "images.image1": ["motion:1:299", 0],
    });
    expect(findFinalCrop(graph)).toEqual([[
      WAN_ANIMATE_FINAL_CROP_NODE_ID,
      expect.objectContaining({
        class_type: "ImageFromBatch",
        inputs: { image: ["289", 0], batch_index: 0, length: desiredFrames },
      }),
    ]]);
    expect(graph["245"].inputs.images).toEqual([WAN_ANIMATE_FINAL_CROP_NODE_ID, 0]);
  });

  it("keeps one CreateVideo and SaveVideo, declares node 246, mutes audio, and keeps source FPS", () => {
    const graph = compileWanAnimateMotion(parameterizedGraph(), planWanAnimateFrames(82));
    const createNodes = Object.entries(graph).filter(([, node]) => node.class_type === "CreateVideo");
    const saveNodes = Object.entries(graph).filter(([, node]) => node.class_type === "SaveVideo");

    expect(createNodes.map(([id]) => id)).toEqual(["245"]);
    expect(saveNodes.map(([id]) => id)).toEqual(["246"]);
    expect(graph["246"].inputs.video).toEqual(["245", 0]);
    expect(graph["245"].inputs).not.toHaveProperty("audio");
    expect(graph["245"].inputs.fps).toEqual(["288", 2]);
  });

  it("preserves every base segment parameter and remaps only intra-segment references in clones", () => {
    const base = parameterizedGraph();
    const graph = compileWanAnimateMotion(base, planWanAnimateFrames(82));

    for (const suffix of segmentSuffixes) {
      const expected = structuredClone(base[`261:${suffix}`]);
      expected.inputs = remapSegmentReferences(expected.inputs, 1) as Record<string, unknown>;

      if (suffix === "247") {
        expected.inputs.continue_motion = ["261:6", 0];
        expected.inputs.video_frame_offset = ["261:247", 5];
      }
      if (suffix === "297") expected.inputs.value = true;

      expect(graph[`motion:1:${suffix}`], `clone ${suffix}`).toEqual(expected);
    }

    expect(graph["189"].inputs.image).toBe("compiler-character.png");
    expect(graph["240"].inputs.file).toBe("compiler-drive.mp4");
    expect(graph["604"].inputs.value).toBe("compiler sentinel motion");
    expect(graph["605"].inputs.value).toContain("compiler sentinel character");
    expect(graph["motion:1:19"].inputs.noise_seed).toBe(987_654_321);
    expect(graph["motion:1:243"].inputs).toMatchObject({ "resize_type.width": 480, "resize_type.height": 848 });
  });

  describe("template drift rejection", () => {
    function rejects(mutator: (graph: ApiGraph) => void, frames = 82) {
      const graph = parameterizedGraph();
      mutator(graph);
      expect(() => compileWanAnimateMotion(graph, planWanAnimateFrames(frames))).toThrow();
    }

    it("rejects missing and wrong outer anchors", () => {
      rejects((graph) => { delete graph["189"]; });
      rejects((graph) => { graph["240"].class_type = "LoadImage"; });
      rejects((graph) => { graph["245"].inputs.fps = ["240", 2]; });
      rejects((graph) => { graph["246"].inputs.video = ["289", 0]; });
    });

    it("rejects missing, extra, or class-drifted base segment members", () => {
      rejects((graph) => { delete graph["261:6"]; });
      rejects((graph) => { graph["261:247"].class_type = "WanImageToVideo"; });
      rejects((graph) => { graph["261:999"] = structuredClone(graph["261:3"]); });
    });

    it("rejects incorrect base trim, offset, continuation, and seam structure", () => {
      rejects((graph) => { graph["261:223"].inputs.samples = ["261:247", 2]; });
      rejects((graph) => { graph["261:223"].inputs.trim_amount = ["261:19", 0]; });
      rejects((graph) => { graph["261:247"].inputs.video_frame_offset = 7; });
      rejects((graph) => { graph["261:247"].inputs.continue_motion = ["261:6", 0]; });
      rejects((graph) => { graph["261:297"].inputs.value = true; });
      rejects((graph) => { graph["261:247"].inputs.length = 80; });
      rejects((graph) => { graph["261:298"].inputs.length = 1; });
    });

    it("rejects extra output, comparison, preview, and unreviewed nodes", () => {
      rejects((graph) => { graph["extra-save"] = structuredClone(graph["246"]); });
      rejects((graph) => { graph["extra-create"] = structuredClone(graph["245"]); });
      rejects((graph) => { graph["comparison"] = { class_type: "ImageStitch", inputs: {} }; });
      rejects((graph) => { graph["preview"] = { class_type: "PreviewAny", inputs: {} }; });
      rejects((graph) => { graph["remote"] = { class_type: "LoadVideo", inputs: { file: "https://example.invalid/a.mp4" } }; });
    });

    it("rejects compiler-owned and continuation-ID collisions", () => {
      rejects((graph) => { graph[WAN_ANIMATE_FINAL_CROP_NODE_ID] = structuredClone(graph["261:298"]); });
      rejects((graph) => { graph["motion:1:3"] = structuredClone(graph["261:3"]); });
    });
  });
});

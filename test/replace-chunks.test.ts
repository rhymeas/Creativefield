import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { ApiGraph } from "../src/workflow/build";
import { assertLocalGraphPolicy } from "../src/capabilities/policy";
import {
  SCAIL_ANCHOR_FRAMES,
  SCAIL_BATCH_NODE_ID,
  SCAIL_CHUNK_FRAMES,
  SCAIL_FINAL_CROP_NODE_ID,
  SCAIL_MAX_CHUNKS,
  SCAIL_MAX_FRAMES,
  SCAIL_STEP_FRAMES,
  compileScailChunks,
  planScailChunks,
  type ScailChunkPlan,
} from "../src/capabilities/replace";

/** Chunk zero keeps the template's own ids; later chunks are cloned under replace:N. */
const chunkId = (ordinal: number, suffix: string) => (ordinal === 0 ? `213:${suffix}` : `replace:${ordinal}:${suffix}`);

/** The template as task 2 leaves it: the window is a fixed 81 frames and the pose
 *  video is the whole resized clip. Applying it twice is harmless. */
function chunkableTemplate(): ApiGraph {
  const graph = JSON.parse(readFileSync("native-workflows/scail2-character-replace/template.api.json", "utf8")) as ApiGraph;
  graph["213:114"].inputs.length = SCAIL_CHUNK_FRAMES;
  graph["213:114"].inputs.video_frame_offset = 0;
  delete graph["213:114"].inputs.previous_frames;
  graph["213:900"].inputs.input = ["213:157", 0];
  return graph;
}

describe("SCAIL-2 replace plan", () => {
  it("uses the window the model was trained at", () => {
    expect([SCAIL_CHUNK_FRAMES, SCAIL_ANCHOR_FRAMES, SCAIL_STEP_FRAMES]).toEqual([81, 5, 76]);
    expect(SCAIL_MAX_CHUNKS).toBe(8);
    expect(SCAIL_MAX_FRAMES).toBe(613);
  });

  it("covers every frame it can reach, for any clip up to the ceiling", () => {
    for (let frames = 1; frames <= SCAIL_MAX_FRAMES; frames += 1) {
      const plan = planScailChunks(frames);
      const emitted = plan.chunks.reduce((total, chunk) => total + chunk.emittedFrames, 0);
      expect(emitted).toBe(plan.emittedFrames);
      expect(emitted - plan.tailTrim).toBe(frames);
      expect(plan.chunkCount).toBe(plan.chunks.length);
      expect(plan.chunkCount).toBeGreaterThanOrEqual(1);
      expect(plan.chunkCount).toBeLessThanOrEqual(SCAIL_MAX_CHUNKS);
      // The 4n+1 rounding can leave the last frames ungenerated; never more than three.
      expect(emitted).toBeLessThanOrEqual(frames);
      expect(frames - emitted).toBeLessThanOrEqual(3);
    }
  });

  it("gives the first chunk the whole window and each later chunk its own step", () => {
    const plan = planScailChunks(200);
    expect(plan.chunks.map(chunk => [chunk.ordinal, chunk.startFrame, chunk.generatedFrames, chunk.anchorFrames, chunk.emittedFrames]))
      .toEqual([[0, 0, 81, 0, 81], [1, 76, 81, 5, 76], [2, 152, 45, 5, 40]]);
    expect(plan).toMatchObject({ frames: 200, chunkCount: 3, generatedFrames: 207, emittedFrames: 197, tailTrim: -3 });
  });

  it("shortens the last window to 4n+1 instead of assuming a plain 76 step", () => {
    const plan = planScailChunks(100);
    // A 24-frame tail is cut to 21 by the node, so only 16 of them are new.
    expect(plan.chunks[1]).toMatchObject({ startFrame: 76, generatedFrames: 21, emittedFrames: 16 });
    expect(plan.tailTrim).toBe(-3);
  });

  it("stops at eight chunks and 613 frames", () => {
    const plan = planScailChunks(SCAIL_MAX_FRAMES);
    expect(plan.chunkCount).toBe(8);
    expect(plan.tailTrim).toBe(0);
    expect(plan.chunks[7]).toMatchObject({ startFrame: 532, generatedFrames: 81, emittedFrames: 76 });
    expect(() => planScailChunks(SCAIL_MAX_FRAMES + 1)).toThrow(/at most 8 chunks/);
  });

  it("drops a chunk that would only repeat the anchor", () => {
    const plan = planScailChunks(82);
    expect(plan).toMatchObject({ chunkCount: 1, emittedFrames: 81, tailTrim: -1 });
    expect(() => compileScailChunks(chunkableTemplate(), plan)).not.toThrow();
  });

  it("refuses frame counts it cannot plan", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => planScailChunks(bad)).toThrow(/positive safe integer/);
    }
  });

  it("hands the compiler a frozen plan", () => {
    const plan = planScailChunks(200);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.chunks)).toBe(true);
    expect(plan.chunks.every(chunk => Object.isFrozen(chunk))).toBe(true);
  });
});

describe("SCAIL-2 replace compile", () => {
  it("chains one condition, sampler and decode per window", () => {
    const graph = compileScailChunks(chunkableTemplate(), planScailChunks(200));

    expect(graph["213:114"].inputs.video_frame_offset).toBe(0);
    expect("previous_frames" in graph["213:114"].inputs).toBe(false);
    for (const ordinal of [1, 2]) {
      expect(graph[chunkId(ordinal, "114")].inputs.video_frame_offset).toEqual([chunkId(ordinal - 1, "114"), 3]);
      expect(graph[chunkId(ordinal, "114")].inputs.previous_frames).toEqual([chunkId(ordinal - 1, "6"), 0]);
      expect(graph[chunkId(ordinal, "19")].inputs.positive).toEqual([chunkId(ordinal, "114"), 0]);
      expect(graph[chunkId(ordinal, "19")].inputs.negative).toEqual([chunkId(ordinal, "114"), 1]);
      expect(graph[chunkId(ordinal, "19")].inputs.latent_image).toEqual([chunkId(ordinal, "114"), 2]);
      expect(graph[chunkId(ordinal, "6")].inputs.samples).toEqual([chunkId(ordinal, "19"), 1]);
    }
  });

  it("joins the windows without the frames the next window repeats", () => {
    const graph = compileScailChunks(chunkableTemplate(), planScailChunks(200));
    expect(graph["replace:1:join"]).toEqual({
      class_type: "ImageFromBatch",
      inputs: { image: ["replace:1:6", 0], batch_index: 5, length: 76 },
    });
    expect(graph["replace:2:join"]?.inputs).toEqual({ image: ["replace:2:6", 0], batch_index: 5, length: 40 });
    expect(graph[SCAIL_BATCH_NODE_ID].inputs).toEqual({
      "images.image0": ["213:6", 0],
      "images.image1": ["replace:1:join", 0],
      "images.image2": ["replace:2:join", 0],
    });
    expect(graph[SCAIL_FINAL_CROP_NODE_ID].inputs).toEqual({ image: [SCAIL_BATCH_NODE_ID, 0], batch_index: 0, length: 200 });
    expect(graph["201"].inputs.images).toEqual([SCAIL_FINAL_CROP_NODE_ID, 0]);
    expect(graph["201"].inputs.fps).toEqual(["215", 2]);
  });

  it("keeps the model, LoRA and mask work in one copy", () => {
    const base = chunkableTemplate();
    const graph = compileScailChunks(base, planScailChunks(SCAIL_MAX_FRAMES));
    const count = (classType: string) => Object.values(graph).filter(node => node.class_type === classType).length;

    expect(count("WanSCAILToVideo")).toBe(8);
    expect(count("SamplerCustom")).toBe(8);
    expect(count("VAEDecode")).toBe(8);
    expect(count("BasicScheduler")).toBe(1);
    expect(count("UNETLoader")).toBe(1);
    expect(count("LoraLoaderModelOnly")).toBe(2);
    // Four tracks: the video people, the first character, the second character, both in one frame.
    expect(count("SAM3_VideoTrack")).toBe(4);
    expect(count("SCAIL2ColoredMask")).toBe(3);
    expect(count("CreateVideo")).toBe(1);
    expect(count("SaveVideo")).toBe(1);
    expect(Object.keys(graph)).toHaveLength(Object.keys(base).length + (8 - 1) * 4 + 2);
  });

  it("carries the run's own bindings into every window", () => {
    const base = chunkableTemplate();
    base["213:19"].inputs.noise_seed = 7;
    base["213:3"].inputs.text = "a red jacket";
    base["213:197"].inputs.object_indices = "1";
    const graph = compileScailChunks(base, planScailChunks(200));

    for (const id of ["213:19", "replace:1:19", "replace:2:19"]) expect(graph[id].inputs.noise_seed).toBe(7);
    for (const id of ["213:114", "replace:1:114", "replace:2:114"]) {
      expect(graph[id].inputs.positive).toEqual(["213:3", 0]);
      expect(graph[id].inputs.pose_video_mask).toEqual(["213:197", 0]);
      expect(graph[id].inputs.length).toBe(SCAIL_CHUNK_FRAMES);
    }
    expect(graph["213:3"].inputs.text).toBe("a red jacket");
    expect(graph["213:197"].inputs.object_indices).toBe("1");
  });

  it("leaves a clip that fits one window exactly as it is", () => {
    const base = chunkableTemplate();
    const graph = compileScailChunks(base, planScailChunks(81));
    expect(graph).toEqual(base);
    expect(graph).not.toBe(base);
    expect(graph["201"].inputs.images).toEqual(["213:6", 0]);
  });

  it("makes a graph the local policy accepts", () => {
    const graph = compileScailChunks(chunkableTemplate(), planScailChunks(SCAIL_MAX_FRAMES));
    expect(() => assertLocalGraphPolicy(graph)).not.toThrow();
  });

  it("refuses a template that still slices the clip to 81 frames", () => {
    const base = chunkableTemplate();
    base["213:900"].inputs.input = ["213:177", 0];
    expect(() => compileScailChunks(base, planScailChunks(200))).toThrow(/whole clip in pose_video/);
  });

  it("refuses a window length taken from the clip", () => {
    const base = chunkableTemplate();
    base["213:114"].inputs.length = ["213:163", 2];
    expect(() => compileScailChunks(base, planScailChunks(200))).toThrow(/window length fixed at 81/);
  });

  it("refuses a template that already continues previous frames", () => {
    const base = chunkableTemplate();
    base["213:114"].inputs.previous_frames = ["213:6", 0];
    expect(() => compileScailChunks(base, planScailChunks(200))).toThrow(/cannot continue previous frames/);
  });

  it("refuses a second reader of the shared decode", () => {
    const base = chunkableTemplate();
    base["202"].inputs.preview = ["213:6", 0];
    expect(() => compileScailChunks(base, planScailChunks(200))).toThrow(/Unexpected consumer of 213:6: 202.preview/);
  });

  it("refuses a graph that already has the compiler's own nodes", () => {
    const base = chunkableTemplate();
    base[SCAIL_BATCH_NODE_ID] = { class_type: "BatchImagesNode", inputs: { "images.image0": ["213:6", 0] } };
    expect(() => compileScailChunks(base, planScailChunks(200))).toThrow(/node collision/);
  });

  it("refuses a plan it did not build", () => {
    const base = chunkableTemplate();
    const plan = planScailChunks(200);
    expect(() => compileScailChunks(base, { ...plan } as ScailChunkPlan)).toThrow(/frozen plan/);
    expect(() => compileScailChunks(base, Object.freeze({ ...plan, chunkCount: 2 }) as ScailChunkPlan)).toThrow(/plan field: chunkCount/);
  });
});

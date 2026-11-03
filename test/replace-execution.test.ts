import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { compileLocal } from "../src/capabilities/compile";
import {
  SCAIL_BATCH_NODE_ID,
  SCAIL_CHUNK_FRAMES,
  SCAIL_FINAL_CROP_NODE_ID,
  planScailChunks,
} from "../src/capabilities/replace";
import type { CapabilityBundle, CapabilityManifestV2, Invocation } from "../src/capabilities/types";
import type { ApiGraph } from "../src/workflow/build";
import { compileRunGraph } from "../server/execution";
import { scailChunksEnabled } from "../server/config";

const root = "native-workflows/scail2-character-replace";
const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, "utf8")) as CapabilityManifestV2;
const template = JSON.parse(readFileSync(`${root}/template.api.json`, "utf8")) as ApiGraph;
const bundle: CapabilityBundle = { manifest, template };
const inputs = { source_video: "comfyfield-clip.mp4", character_image: "comfyfield-face.png" };
const invocation: Invocation = {
  capabilityId: manifest.id, version: manifest.version, routeId: "local",
  inputs: {}, controls: { prompt: "A man in a red jacket", person: "1", seed: 13 }, audioPolicy: "mute",
};
const count = (graph: ApiGraph, classType: string) => Object.values(graph).filter(node => node.class_type === classType).length;
/** Every pass of a replace clip: the first at the template's id, later ones under replace:N. */
const passIds = ["213:114", "replace:1:114", "replace:2:114"];
const chunkId = (ordinal: number, suffix: string) => (ordinal === 0 ? `213:${suffix}` : `replace:${ordinal}:${suffix}`);

describe("replace character run compile", () => {
  // The chunked compile is what the switch turns on; these tests are about that compile.
  beforeEach(() => vi.stubEnv("COMFYFIELD_SCAIL_CHUNKS", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it("posts the reviewed graph for a clip that fits one window", () => {
    const graph = compileRunGraph(bundle, invocation, inputs, 81);
    expect(graph).toEqual(compileLocal(bundle, { ...invocation, inputs }));
    expect(count(graph, "WanSCAILToVideo")).toBe(1);
    expect(count(graph, "BatchImagesNode")).toBe(0);
  });

  it("posts one pass per 81-frame window for a long clip", () => {
    const graph = compileRunGraph(bundle, invocation, inputs, 169);
    expect(count(graph, "WanSCAILToVideo")).toBe(3);
    expect(count(graph, "SamplerCustom")).toBe(3);
    expect(count(graph, "VAEDecode")).toBe(3);
    // The model, the scheduler and the tracked masks still load and run once.
    expect(count(graph, "BasicScheduler")).toBe(1);
    expect(count(graph, "SAM3_VideoTrack")).toBe(count(template, "SAM3_VideoTrack"));
    expect(count(graph, "CreateVideo")).toBe(1);
    expect(count(graph, "SaveVideo")).toBe(1);
    expect(count(graph, "BatchImagesNode")).toBe(1);
    expect(graph[SCAIL_FINAL_CROP_NODE_ID].inputs).toEqual({ image: [SCAIL_BATCH_NODE_ID, 0], batch_index: 0, length: 169 });
    expect(graph["201"].inputs.images).toEqual([SCAIL_FINAL_CROP_NODE_ID, 0]);
  });

  it("hands every pass the window the model was trained at", () => {
    const graph = compileRunGraph(bundle, invocation, inputs, 169);
    for (const id of passIds) expect(graph[id].inputs.length).toBe(SCAIL_CHUNK_FRAMES);
    expect(graph["213:114"].inputs.video_frame_offset).toBe(0);
    expect("previous_frames" in graph["213:114"].inputs).toBe(false);
    for (const ordinal of [1, 2]) {
      expect(graph[chunkId(ordinal, "114")].inputs.video_frame_offset).toEqual([chunkId(ordinal - 1, "114"), 3]);
      expect(graph[chunkId(ordinal, "114")].inputs.previous_frames).toEqual([chunkId(ordinal - 1, "6"), 0]);
      expect(graph[`replace:${ordinal}:join`].inputs).toEqual({
        image: [chunkId(ordinal, "6"), 0], batch_index: 5, length: planScailChunks(169).chunks[ordinal].emittedFrames,
      });
    }
  });

  it("keeps the run's prompt, person and seed in every pass", () => {
    const graph = compileRunGraph(bundle, invocation, inputs, 169);
    expect(graph["213:3"].inputs.text).toBe("A man in a red jacket");
    expect(graph["213:197"].inputs.object_indices).toBe("1");
    expect(graph["30"].inputs.image).toBe("comfyfield-face.png");
    for (const id of ["213:19", "replace:1:19", "replace:2:19"]) expect(graph[id].inputs.noise_seed).toBe(13);
    for (const id of passIds) {
      expect(graph[id].inputs.positive).toEqual(["213:3", 0]);
      expect(graph[id].inputs.pose_video_mask).toEqual(["213:197", 0]);
    }
  });

  it("builds the eight passes the clip ceiling allows", () => {
    const graph = compileRunGraph(bundle, invocation, inputs, 613);
    expect(count(graph, "WanSCAILToVideo")).toBe(8);
    expect(planScailChunks(613).tailTrim).toBe(0);
    expect(graph[SCAIL_FINAL_CROP_NODE_ID].inputs.length).toBe(613);
  });

  it("refuses a replace clip without its frame count", () => {
    expect(() => compileRunGraph(bundle, invocation, inputs)).toThrow(/frame count/);
  });

  it("compiles every other capability exactly as before", () => {
    const { replaceContract: _replace, ...rest } = manifest;
    const plain: CapabilityBundle = { manifest: rest as CapabilityManifestV2, template };
    expect(compileRunGraph(plain, invocation, inputs, 169)).toEqual(compileLocal(plain, { ...invocation, inputs }));
  });
});

describe("replace character chunk switch", () => {
  beforeEach(() => vi.stubEnv("COMFYFIELD_SCAIL_CHUNKS", ""));
  afterEach(() => vi.unstubAllEnvs());

  it("is off unless set to 1", () => {
    expect(scailChunksEnabled({})).toBe(false);
    expect(scailChunksEnabled({ COMFYFIELD_SCAIL_CHUNKS: "" })).toBe(false);
    expect(scailChunksEnabled({ COMFYFIELD_SCAIL_CHUNKS: "0" })).toBe(false);
    expect(scailChunksEnabled({ COMFYFIELD_SCAIL_CHUNKS: "true" })).toBe(false);
    expect(scailChunksEnabled({ COMFYFIELD_SCAIL_CHUNKS: " 1 " })).toBe(true);
  });

  it("posts one 81-frame pass for a long clip while chunks are off", () => {
    const graph = compileRunGraph(bundle, invocation, inputs, 169);
    expect(graph).toEqual(compileLocal(bundle, { ...invocation, inputs }));
    expect(count(graph, "WanSCAILToVideo")).toBe(1);
    expect(count(graph, "BatchImagesNode")).toBe(0);
  });

  it("keeps the largest clip one pass while chunks are off", () => {
    const graph = compileRunGraph(bundle, invocation, inputs, 613);
    expect(graph).toEqual(compileLocal(bundle, { ...invocation, inputs }));
    expect(count(graph, "WanSCAILToVideo")).toBe(1);
  });

  it("still refuses a replace clip without its frame count", () => {
    expect(() => compileRunGraph(bundle, invocation, inputs)).toThrow(/frame count/);
  });
});

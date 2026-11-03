import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { ApiGraph } from "../src/workflow/build";
import { SCAIL_CHUNK_FRAMES, compileScailChunks, planScailChunks, scailChunkParts } from "../src/capabilities/replace";
import { developStage, stageForNode } from "../server/develop";
import { chainKeyPrefix, chainPart } from "../server/progress";

/** The class of the node the worker names says what the job is doing. */
describe("develop stage per node class", () => {
  it.each([
    // Fetching a model or a file: nothing is made yet.
    ["LoadImage", "preparing"],
    ["LoadVideo", "preparing"],
    ["CheckpointLoaderSimple", "preparing"],
    ["UNETLoader", "preparing"],
    ["VAELoader", "preparing"],
    ["CLIPLoader", "preparing"],
    ["CLIPVisionLoader", "preparing"],
    ["LoraLoaderModelOnly", "preparing"],
    ["PrimitiveInt", "preparing"],
    ["ModelSamplingSD3", "preparing"],
    // Finding out what is in the picture or the clip.
    ["SAM3_VideoTrack", "thinking"],
    ["SAM3_TrackToMask", "thinking"],
    ["SCAIL2ColoredMask", "thinking"],
    ["MaskToImage", "thinking"],
    ["CLIPTextEncode", "thinking"],
    ["CLIPVisionEncode", "thinking"],
    ["TextGenerate", "thinking"],
    ["ResizeImageMaskNode", "thinking"],
    ["ImageCompositeMasked", "thinking"],
    ["ImageFromBatch", "thinking"],
    ["WanSCAILToVideo", "thinking"],
    // The sampler paints the frames.
    ["SamplerCustom", "working"],
    ["KSampler", "working"],
    ["KSamplerAdvanced", "working"],
    ["KSamplerSelect", "working"],
    ["BasicScheduler", "working"],
    ["CFGGuider", "working"],
    // Writing the result out.
    ["VAEDecode", "rendering"],
    ["VAEDecodeTiled", "rendering"],
    ["SaveVideo", "rendering"],
    ["SaveImage", "rendering"],
    ["SaveAudio", "rendering"],
    ["SaveGLB", "rendering"],
    ["PreviewAny", "rendering"],
    ["CreateVideo", "rendering"],
    ["VHS_VideoCombine", "rendering"],
    ["ImageStitch", "rendering"],
    // Sharpening the result.
    ["ImageUpscaleWithModel", "upscaling"],
    ["UltimateSDUpscale", "upscaling"],
    ["LatentUpscale", "upscaling"],
  ])("names %s as %s", (classType, stage) => {
    expect(developStage(classType)).toBe(stage);
  });

  it("reads a loading upscale model as getting ready, not as sharpening", () => {
    expect(developStage("UpscaleModelLoader")).toBe("preparing");
  });

  it("says nothing for a class it does not know, and for no node at all", () => {
    expect(developStage("")).toBeUndefined();
    expect(developStage(null)).toBeUndefined();
    expect(developStage("SomeNodeNobodyHasSeenYet")).toBeUndefined();
    expect(stageForNode({ "213:19": { class_type: "SamplerCustom" } }, null)).toBeUndefined();
    expect(stageForNode({ "213:19": { class_type: "SamplerCustom" } }, "gone")).toBeUndefined();
    expect(stageForNode(null, "213:19")).toBeUndefined();
  });

  it("reads the stage from the class the run's own graph gives the reported node", () => {
    const graph = {
      "213:6": { class_type: "VAEDecode" },
      "213:19": { class_type: "SamplerCustom" },
      "331": { class_type: "SAM3_VideoTrack" },
    };
    expect(stageForNode(graph, "213:19")).toBe("working");
    expect(stageForNode(graph, "213:6")).toBe("rendering");
    expect(stageForNode(graph, "331")).toBe("thinking");
  });
});

/** A clip the chunk compiler can chain: the window is fixed and the pose video is the whole clip. */
function chunkableTemplate(): ApiGraph {
  const graph = JSON.parse(readFileSync("native-workflows/scail2-character-replace/template.api.json", "utf8")) as ApiGraph;
  graph["213:114"].inputs.length = SCAIL_CHUNK_FRAMES;
  graph["213:114"].inputs.video_frame_offset = 0;
  delete graph["213:114"].inputs.previous_frames;
  graph["213:900"].inputs.input = ["213:157", 0];
  return graph;
}

/** The windowed part of one replace run: replace:1 is the second window, so its sampler is part 2. */
describe("the part of a chained replace window", () => {
  it("names the window from the node id and the count from the graph", () => {
    const graph = compileScailChunks(chunkableTemplate(), planScailChunks(261));
    expect(scailChunkParts(graph, "213:19")).toEqual({ part: 1, parts: 4 });
    expect(scailChunkParts(graph, "replace:1:19")).toEqual({ part: 2, parts: 4 });
    expect(scailChunkParts(graph, "replace:3:6")).toEqual({ part: 4, parts: 4 });
  });

  it("keeps work shared by the whole job with the first window", () => {
    const graph = compileScailChunks(chunkableTemplate(), planScailChunks(200));
    // The models, the mask tracking and the scheduler run once, before any window is joined.
    expect(scailChunkParts(graph, "331")).toBeUndefined();
    expect(scailChunkParts(graph, "213:18")).toEqual({ part: 1, parts: 3 });
  });

  it("has no parts for a clip that fits one window, or for nothing to go on", () => {
    const graph = compileScailChunks(chunkableTemplate(), planScailChunks(81));
    expect(scailChunkParts(graph, "213:19")).toBeUndefined();
    expect(scailChunkParts(graph, null)).toBeUndefined();
    expect(scailChunkParts(null, "213:19")).toBeUndefined();
    expect(scailChunkParts(compileScailChunks(chunkableTemplate(), planScailChunks(200)), "gone")).toBeUndefined();
  });
});

/** A request that takes several runs: they share one idempotency key start, so the second is part 2. */
describe("the part of a chained request", () => {
  const request = "replace-61283272-6465-419c-aeca-0071fdd287d6";
  const first = `${request}-replace-0`;
  const second = `${request}-replace-1`;

  it("reads the request every step of one chain belongs to", () => {
    expect(chainKeyPrefix(first)).toBe(`${request}-`);
    expect(chainKeyPrefix(second)).toBe(`${request}-`);
    expect(chainKeyPrefix("swap-2-mask")).toBe("swap-2-");
  });

  it("leaves a key that names one run alone", () => {
    expect(chainKeyPrefix("5d244e76-4809-4b3c-b51c-6a798ef030cb")).toBeUndefined();
    expect(chainKeyPrefix("cloud-replace-214e75bd-938f-4220-a466-99e581db99e7")).toBeUndefined();
    expect(chainKeyPrefix("replace-notarequest-replace-0")).toBeUndefined();
    expect(chainKeyPrefix(null)).toBeUndefined();
  });

  it("counts the step among the steps queued so far, so the second run is part 2", () => {
    expect(chainPart([first], first)).toEqual({ part: 1, parts: 1 });
    expect(chainPart([first, second], first)).toEqual({ part: 1, parts: 2 });
    expect(chainPart([first, second], second)).toEqual({ part: 2, parts: 2 });
    expect(chainPart([first, second], "replace-other-replace-0")).toBeUndefined();
    expect(chainPart([first], null)).toBeUndefined();
  });
});

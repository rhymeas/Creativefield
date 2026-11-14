import type { ApiGraph } from "../workflow/build";
import { assertLocalGraphPolicy } from "./policy";

export const WAN_ANIMATE_CHUNK_FRAMES = 81;
export const WAN_ANIMATE_OVERLAP_FRAMES = 1;
export const WAN_ANIMATE_UNIQUE_FRAMES_PER_CHUNK = 80;
export const WAN_ANIMATE_MAX_CHUNKS = 8;
export const WAN_ANIMATE_MAX_DESIRED_FRAMES =
  WAN_ANIMATE_UNIQUE_FRAMES_PER_CHUNK * WAN_ANIMATE_MAX_CHUNKS + WAN_ANIMATE_OVERLAP_FRAMES;
export const WAN_ANIMATE_FINAL_CROP_NODE_ID = "motion:final:crop";

export type WanAnimateChunkRecord = Readonly<{
  ordinal: number;
  startFrame: number;
  generatedFrames: typeof WAN_ANIMATE_CHUNK_FRAMES;
  overlapFrames: 0 | typeof WAN_ANIMATE_OVERLAP_FRAMES;
  /** Frames from this chunk that remain after seam removal and the final crop. */
  emittedFrames: number;
}>;

export type WanAnimatePlan = Readonly<{
  desiredFrames: number;
  chunkFrames: typeof WAN_ANIMATE_CHUNK_FRAMES;
  overlapFrames: typeof WAN_ANIMATE_OVERLAP_FRAMES;
  uniquePerChunk: typeof WAN_ANIMATE_UNIQUE_FRAMES_PER_CHUNK;
  chunkCount: number;
  generatedFrames: number;
  tailTrimFrames: number;
  chunks: readonly WanAnimateChunkRecord[];
}>;

const SEGMENT_CLASSES = {
  "3": "CLIPTextEncode",
  "4": "CLIPTextEncode",
  "6": "VAEDecode",
  "7": "VAELoader",
  "9": "CLIPLoader",
  "18": "BasicScheduler",
  "19": "SamplerCustom",
  "27": "KSamplerSelect",
  "75": "CLIPVisionLoader",
  "76": "CLIPVisionEncode",
  "95": "ModelSamplingSD3",
  "220": "CLIPVisionEncode",
  "222": "CLIPTextEncode",
  "223": "TrimVideoLatent",
  "224": "WanAnimate2Cache",
  "236": "ImageFromBatch",
  "239": "UNETLoader",
  "241": "GetVideoComponents",
  "243": "ResizeImageMaskNode",
  "244": "ResizeImageMaskNode",
  "247": "WanAnimate2ToVideo",
  "256": "GetImageSize",
  "257": "ContextWindowsManual",
  "258": "ComfySwitchNode",
  "297": "PrimitiveBoolean",
  "298": "ImageFromBatch",
  "299": "ComfySwitchNode",
} as const;

const OUTER_CLASSES = {
  "189": "LoadImage",
  "240": "LoadVideo",
  "604": "PrimitiveStringMultiline",
  "605": "PrimitiveStringMultiline",
  "288": "GetVideoComponents",
  "289": "BatchImagesNode",
  "245": "CreateVideo",
  "246": "SaveVideo",
} as const;

export const WAN_ANIMATE_SEGMENT_SUFFIXES = Object.freeze(
  Object.keys(SEGMENT_CLASSES) as Array<keyof typeof SEGMENT_CLASSES>,
);

const BASE_SEGMENT_PREFIX = "261:";

function freezeRecord(record: WanAnimateChunkRecord): WanAnimateChunkRecord {
  return Object.freeze(record);
}

export function planWanAnimateFrames(desiredFrames: number): WanAnimatePlan {
  if (!Number.isSafeInteger(desiredFrames) || desiredFrames < 1) {
    throw new Error("Wan Animate desired frame count must be a positive safe integer");
  }
  if (desiredFrames > WAN_ANIMATE_MAX_DESIRED_FRAMES) {
    throw new Error(`Wan Animate supports at most ${WAN_ANIMATE_MAX_CHUNKS} chunks (${WAN_ANIMATE_MAX_DESIRED_FRAMES} frames)`);
  }

  const chunkCount = Math.max(
    1,
    Math.ceil((desiredFrames - WAN_ANIMATE_OVERLAP_FRAMES) / WAN_ANIMATE_UNIQUE_FRAMES_PER_CHUNK),
  );
  const generatedFrames = WAN_ANIMATE_UNIQUE_FRAMES_PER_CHUNK * chunkCount + WAN_ANIMATE_OVERLAP_FRAMES;
  const tailTrimFrames = generatedFrames - desiredFrames;
  const chunks = Array.from({ length: chunkCount }, (_, ordinal) => {
    const rawContribution = ordinal === 0 ? WAN_ANIMATE_CHUNK_FRAMES : WAN_ANIMATE_UNIQUE_FRAMES_PER_CHUNK;
    const emittedFrames = rawContribution - (ordinal === chunkCount - 1 ? tailTrimFrames : 0);
    return freezeRecord({
      ordinal,
      startFrame: ordinal * WAN_ANIMATE_UNIQUE_FRAMES_PER_CHUNK,
      generatedFrames: WAN_ANIMATE_CHUNK_FRAMES,
      overlapFrames: ordinal === 0 ? 0 : WAN_ANIMATE_OVERLAP_FRAMES,
      emittedFrames,
    });
  });

  return Object.freeze({
    desiredFrames,
    chunkFrames: WAN_ANIMATE_CHUNK_FRAMES,
    overlapFrames: WAN_ANIMATE_OVERLAP_FRAMES,
    uniquePerChunk: WAN_ANIMATE_UNIQUE_FRAMES_PER_CHUNK,
    chunkCount,
    generatedFrames,
    tailTrimFrames,
    chunks: Object.freeze(chunks),
  });
}

function linkEquals(value: unknown, node: string, output: number): boolean {
  return Array.isArray(value) && value.length === 2 && value[0] === node && value[1] === output;
}

function requireLink(value: unknown, node: string, output: number, label: string): void {
  if (!linkEquals(value, node, output)) throw new Error(`Invalid Wan Animate link: ${label}`);
}

function validatePlan(plan: WanAnimatePlan): void {
  if (!Object.isFrozen(plan) || !Object.isFrozen(plan.chunks) || plan.chunks.some(chunk => !Object.isFrozen(chunk))) {
    throw new Error("Wan Animate compiler requires a frozen plan");
  }
  const expected = planWanAnimateFrames(plan.desiredFrames);
  const scalarKeys: Array<Exclude<keyof WanAnimatePlan, "chunks">> = [
    "desiredFrames", "chunkFrames", "overlapFrames", "uniquePerChunk", "chunkCount", "generatedFrames", "tailTrimFrames",
  ];
  for (const key of scalarKeys) if (plan[key] !== expected[key]) throw new Error(`Invalid Wan Animate plan field: ${key}`);
  if (plan.chunks.length !== expected.chunks.length) throw new Error("Invalid Wan Animate plan chunks");
  for (let index = 0; index < expected.chunks.length; index += 1) {
    const actual = plan.chunks[index];
    const wanted = expected.chunks[index];
    if (!actual || Object.keys(wanted).some(key => actual[key as keyof WanAnimateChunkRecord] !== wanted[key as keyof WanAnimateChunkRecord])) {
      throw new Error(`Invalid Wan Animate chunk record: ${index}`);
    }
  }
}

function segmentId(ordinal: number, suffix: string): string {
  return ordinal === 0 ? `${BASE_SEGMENT_PREFIX}${suffix}` : `motion:${ordinal}:${suffix}`;
}

function assertNodeClass(graph: ApiGraph, id: string, expectedClass: string): void {
  const node = graph[id];
  if (!node) throw new Error(`Missing Wan Animate node: ${id}`);
  if (node.class_type !== expectedClass) throw new Error(`Wan Animate class drift at ${id}: expected ${expectedClass}`);
}

function validateBaseGraph(graph: ApiGraph): void {
  if (WAN_ANIMATE_FINAL_CROP_NODE_ID in graph) throw new Error(`Wan Animate compiler node collision: ${WAN_ANIMATE_FINAL_CROP_NODE_ID}`);

  for (const [id, node] of Object.entries(graph)) {
    if (/preview|compare/i.test(node.class_type)) throw new Error(`Comparison or preview node is not allowed: ${id}`);
  }

  const expectedIds = new Set<string>([
    ...Object.keys(OUTER_CLASSES),
    ...WAN_ANIMATE_SEGMENT_SUFFIXES.map(suffix => `${BASE_SEGMENT_PREFIX}${suffix}`),
  ]);
  for (const id of Object.keys(graph)) if (!expectedIds.has(id)) throw new Error(`Unexpected Wan Animate node: ${id}`);
  for (const id of expectedIds) if (!(id in graph)) throw new Error(`Missing Wan Animate node: ${id}`);

  for (const [id, expectedClass] of Object.entries(OUTER_CLASSES)) assertNodeClass(graph, id, expectedClass);
  for (const suffix of WAN_ANIMATE_SEGMENT_SUFFIXES) {
    assertNodeClass(graph, `${BASE_SEGMENT_PREFIX}${suffix}`, SEGMENT_CLASSES[suffix]);
  }

  const createNodes = Object.entries(graph).filter(([, node]) => node.class_type === "CreateVideo");
  const saveNodes = Object.entries(graph).filter(([, node]) => node.class_type === "SaveVideo");
  if (createNodes.length !== 1 || createNodes[0]?.[0] !== "245") throw new Error("Wan Animate requires exactly one CreateVideo node at 245");
  if (saveNodes.length !== 1 || saveNodes[0]?.[0] !== "246") throw new Error("Wan Animate requires exactly one SaveVideo node at 246");

  requireLink(graph["245"].inputs.images, "289", 0, "245.images");
  requireLink(graph["245"].inputs.fps, "288", 2, "245.fps");
  if ("audio" in graph["245"].inputs) requireLink(graph["245"].inputs.audio, "288", 1, "245.audio");
  requireLink(graph["246"].inputs.video, "245", 0, "246.video");
  requireLink(graph["288"].inputs.video, "240", 0, "288.video");
  if (Object.keys(graph["289"].inputs).length !== 1) throw new Error("Base Wan Animate batch membership has changed");
  requireLink(graph["289"].inputs["images.image0"], "261:299", 0, "289.images.image0");

  const wan = graph["261:247"].inputs;
  if (wan.length !== WAN_ANIMATE_CHUNK_FRAMES) throw new Error("Wan Animate chunk length must be 81");
  if ("continue_motion" in wan) throw new Error("First Wan Animate chunk cannot continue prior motion");
  if (wan.video_frame_offset !== 0) throw new Error("First Wan Animate chunk offset must be zero");
  if (graph["261:297"].inputs.value !== false) throw new Error("First Wan Animate seam trim must be disabled");
  requireLink(graph["261:6"].inputs.samples, "261:223", 0, "261:6.samples");
  requireLink(graph["261:223"].inputs.samples, "261:19", 0, "261:223.samples");
  requireLink(graph["261:223"].inputs.trim_amount, "261:247", 3, "261:223.trim_amount");
  requireLink(graph["261:298"].inputs.image, "261:6", 0, "261:298.image");
  if (graph["261:298"].inputs.batch_index !== 1) throw new Error("Wan Animate seam trim must drop exactly one frame");
  if (graph["261:298"].inputs.length !== 4096) throw new Error("Wan Animate seam trim length has changed");
  requireLink(graph["261:299"].inputs.switch, "261:297", 0, "261:299.switch");
  requireLink(graph["261:299"].inputs.on_false, "261:6", 0, "261:299.on_false");
  requireLink(graph["261:299"].inputs.on_true, "261:298", 0, "261:299.on_true");

  assertLocalGraphPolicy(graph);
}

function rewriteSegmentLinks(value: unknown, ordinal: number): unknown {
  if (Array.isArray(value)) {
    if (
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "number" &&
      value[0].startsWith(BASE_SEGMENT_PREFIX)
    ) {
      const suffix = value[0].slice(BASE_SEGMENT_PREFIX.length);
      if (!(suffix in SEGMENT_CLASSES)) throw new Error(`Wan Animate reference leaves reviewed segment: ${value[0]}`);
      return [segmentId(ordinal, suffix), value[1]];
    }
    return value.map(item => rewriteSegmentLinks(item, ordinal));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteSegmentLinks(item, ordinal)]));
  }
  return value;
}

function validateCompiledChunk(graph: ApiGraph, ordinal: number): void {
  const own = (suffix: string) => segmentId(ordinal, suffix);
  const wan = graph[own("247")].inputs;
  if (wan.length !== WAN_ANIMATE_CHUNK_FRAMES) throw new Error(`Compiled Wan Animate chunk ${ordinal} length drift`);
  requireLink(graph[own("6")].inputs.samples, own("223"), 0, `${own("6")}.samples`);
  requireLink(graph[own("223")].inputs.samples, own("19"), 0, `${own("223")}.samples`);
  requireLink(graph[own("223")].inputs.trim_amount, own("247"), 3, `${own("223")}.trim_amount`);
  requireLink(graph[own("298")].inputs.image, own("6"), 0, `${own("298")}.image`);
  if (graph[own("298")].inputs.batch_index !== 1) throw new Error(`Compiled Wan Animate chunk ${ordinal} seam index drift`);
  if (graph[own("298")].inputs.length !== 4096) throw new Error(`Compiled Wan Animate chunk ${ordinal} seam length drift`);
  requireLink(graph[own("299")].inputs.switch, own("297"), 0, `${own("299")}.switch`);
  requireLink(graph[own("299")].inputs.on_false, own("6"), 0, `${own("299")}.on_false`);
  requireLink(graph[own("299")].inputs.on_true, own("298"), 0, `${own("299")}.on_true`);

  if (ordinal === 0) {
    if ("continue_motion" in wan || wan.video_frame_offset !== 0 || graph[own("297")].inputs.value !== false) {
      throw new Error("Compiled first Wan Animate chunk has continuation state");
    }
  } else {
    const previous = (suffix: string) => segmentId(ordinal - 1, suffix);
    requireLink(wan.continue_motion, previous("6"), 0, `${own("247")}.continue_motion`);
    requireLink(wan.video_frame_offset, previous("247"), 5, `${own("247")}.video_frame_offset`);
    if (graph[own("297")].inputs.value !== true) throw new Error(`Compiled Wan Animate chunk ${ordinal} seam trim is disabled`);
  }
}

/**
 * Expand a reviewed, already-parameterized Wan Animate graph into a deterministic
 * multi-chunk graph. This only constructs graph JSON; it does not establish runtime readiness.
 */
export function compileWanAnimateMotion(baseGraph: ApiGraph, plan: WanAnimatePlan): ApiGraph {
  validatePlan(plan);
  validateBaseGraph(baseGraph);

  const graph: ApiGraph = structuredClone(baseGraph);
  for (let ordinal = 1; ordinal < plan.chunkCount; ordinal += 1) {
    for (const suffix of WAN_ANIMATE_SEGMENT_SUFFIXES) {
      const id = segmentId(ordinal, suffix);
      if (id in graph) throw new Error(`Wan Animate compiler node collision: ${id}`);
      const baseNode = structuredClone(baseGraph[`${BASE_SEGMENT_PREFIX}${suffix}`]);
      graph[id] = {
        ...baseNode,
        inputs: rewriteSegmentLinks(baseNode.inputs, ordinal) as Record<string, unknown>,
      };
    }

    const wan = graph[segmentId(ordinal, "247")].inputs;
    wan.continue_motion = [segmentId(ordinal - 1, "6"), 0];
    wan.video_frame_offset = [segmentId(ordinal - 1, "247"), 5];
    graph[segmentId(ordinal, "297")].inputs.value = true;
  }

  graph["289"].inputs = Object.fromEntries(
    plan.chunks.map(chunk => [`images.image${chunk.ordinal}`, [segmentId(chunk.ordinal, "299"), 0]]),
  );
  graph[WAN_ANIMATE_FINAL_CROP_NODE_ID] = {
    class_type: "ImageFromBatch",
    inputs: { image: ["289", 0], batch_index: 0, length: plan.desiredFrames },
  };
  graph["245"].inputs.images = [WAN_ANIMATE_FINAL_CROP_NODE_ID, 0];
  graph["245"].inputs.fps = ["288", 2];
  delete graph["245"].inputs.audio;

  for (let ordinal = 0; ordinal < plan.chunkCount; ordinal += 1) validateCompiledChunk(graph, ordinal);
  const expectedIds = Object.keys(baseGraph).length + (plan.chunkCount - 1) * WAN_ANIMATE_SEGMENT_SUFFIXES.length + 1;
  if (Object.keys(graph).length !== expectedIds) throw new Error("Compiled Wan Animate graph membership drift");
  if (Object.values(graph).filter(node => node.class_type === "CreateVideo").length !== 1) throw new Error("Compiled Wan Animate graph must contain one CreateVideo");
  if (Object.values(graph).filter(node => node.class_type === "SaveVideo").length !== 1 || graph["246"].class_type !== "SaveVideo") {
    throw new Error("Compiled Wan Animate graph must contain SaveVideo at 246");
  }
  assertLocalGraphPolicy(graph);
  return graph;
}

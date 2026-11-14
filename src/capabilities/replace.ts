import type { ApiGraph } from "../workflow/build";
import { assertLocalGraphPolicy } from "./policy";

/** SCAIL-2 replaces one window at a time: 81 frames of pose and mask, of which the
 * first 5 are the previous window's last 5 frames, re-encoded as the extension
 * anchor. The model was trained at that window and step, so every chunk uses them. */
export const SCAIL_CHUNK_FRAMES = 81;
export const SCAIL_ANCHOR_FRAMES = 5;
export const SCAIL_STEP_FRAMES = SCAIL_CHUNK_FRAMES - SCAIL_ANCHOR_FRAMES;
export const SCAIL_MAX_CHUNKS = 8;
/** Eight windows, each adding 76 new frames: 613 frames is the honest ceiling. */
export const SCAIL_MAX_FRAMES = SCAIL_CHUNK_FRAMES + SCAIL_STEP_FRAMES * (SCAIL_MAX_CHUNKS - 1);
export const SCAIL_BATCH_NODE_ID = "replace:batch";
export const SCAIL_FINAL_CROP_NODE_ID = "replace:final:crop";

/** The reviewed single-view nodes, and the one-frame two-person nodes the pack's 0.5.0 template added. */
const SECOND_LOADER_NODE = "330";
const SECOND_TRACK_NODE = "331";
const SECOND_MASK_NODE = "332";
/** A black frame at the video's shape: the canvas both characters are pasted onto. */
const BLACK_FRAME_NODE = "337";
/** The canvas after the first person is pasted at its left edge. */
const FIRST_IN_FRAME_NODE = "340";
const FIRST_HALF_NODE = "346";
const SECOND_HALF_NODE = "347";
const BOTH_IN_ONE_FRAME_NODE = "341";
const HALF_WIDTH_NODE = "348";
const BOTH_TRACK_NODE = "345";
const BOTH_MASK_NODE = "349";
const BOTH_CROP_NODE = "350";
const BOTH_COLOURS_NODE = "352";
const BOTH_COLOURS_CROP_NODE = "353";
const IMAGE_SWITCH_NODE = "342";
const MASK_SWITCH_NODE = "343";
/** The one decision: off keeps the reviewed single view, on adds the second picture to one frame. */
const TWO_PEOPLE_NODE = "344";

const CONDITION_NODE = "213:114";
const SAMPLER_NODE = "213:19";
const DECODE_NODE = "213:6";
const TEMPLATE_PREFIX = "213:";
const CLONE_SUFFIXES = ["114", "19", "6"] as const;
const CLONE_SOURCES = new Set<string>(CLONE_SUFFIXES.map(suffix => `${TEMPLATE_PREFIX}${suffix}`));

export type ScailChunkRecord = Readonly<{
  ordinal: number;
  /** Source frame the chunk's window starts at. For a later chunk the first
   *  anchorFrames frames repeat what the previous chunk already emitted. */
  startFrame: number;
  /** Window length after the node's 4n+1 rounding. */
  generatedFrames: number;
  anchorFrames: 0 | typeof SCAIL_ANCHOR_FRAMES;
  /** New frames this chunk adds to the joined video. */
  emittedFrames: number;
}>;

export type ScailChunkPlan = Readonly<{
  frames: number;
  chunkFrames: typeof SCAIL_CHUNK_FRAMES;
  anchorFrames: typeof SCAIL_ANCHOR_FRAMES;
  stepFrames: number;
  chunkCount: number;
  generatedFrames: number;
  emittedFrames: number;
  /** emittedFrames - frames. Positive is what the final crop drops. Negative means
   *  the 4n+1 rounding cannot reach the last source frames (at most 3). */
  tailTrim: number;
  chunks: readonly ScailChunkRecord[];
}>;

function freezeRecord(record: ScailChunkRecord): ScailChunkRecord {
  return Object.freeze(record);
}

function link(value: unknown): [string, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [node, output] = value;
  return typeof node === "string" && typeof output === "number" ? [node, output] : undefined;
}

function linkEquals(value: unknown, node: string, output: number): boolean {
  const source = link(value);
  return source !== undefined && source[0] === node && source[1] === output;
}

function requireLink(value: unknown, node: string, output: number, label: string): void {
  if (!linkEquals(value, node, output)) throw new Error(`Invalid SCAIL-2 replace link: ${label}`);
}

/** WanSCAILToVideo cuts pose and mask to ((min(rest, length) - 1) / 4) * 4 + 1 frames.
 *  A plain 76-frame step is 1 to 3 frames short at the end of the clip. */
export function scailWindowFrames(available: number): number {
  return Math.floor((Math.min(available, SCAIL_CHUNK_FRAMES) - 1) / 4) * 4 + 1;
}

/** The people a pass replaces, in the order the coloured mask paints them left to right:
 *  "0" for one person, "0,1" for the first two. SCAIL2ColoredMask reads the same string. */
export function scailPersonIndices(indices: readonly number[]): string {
  const chosen = [...new Set(indices)].sort((a, b) => a - b);
  if (!chosen.length || chosen.some(index => !Number.isSafeInteger(index) || index < 0)) {
    throw new Error("SCAIL-2 replace needs at least one person to replace");
  }
  return chosen.join(",");
}

export function planScailChunks(frames: number): ScailChunkPlan {
  if (!Number.isSafeInteger(frames) || frames < 1) {
    throw new Error("SCAIL-2 replace frame count must be a positive safe integer");
  }
  if (frames > SCAIL_MAX_FRAMES) {
    throw new Error(`SCAIL-2 replace supports at most ${SCAIL_MAX_CHUNKS} chunks (${SCAIL_MAX_FRAMES} frames)`);
  }

  const chunks: ScailChunkRecord[] = [];
  let nextOffset = 0;
  while (nextOffset < frames) {
    if (chunks.length === SCAIL_MAX_CHUNKS) {
      throw new Error(`SCAIL-2 replace supports at most ${SCAIL_MAX_CHUNKS} chunks (${SCAIL_MAX_FRAMES} frames)`);
    }
    const ordinal = chunks.length;
    const anchorFrames = ordinal === 0 ? 0 : SCAIL_ANCHOR_FRAMES;
    // The node subtracts the anchor count from the offset it is handed, so a later
    // chunk's window opens anchorFrames before the frame its new frames start at.
    const startFrame = Math.max(0, nextOffset - anchorFrames);
    const generatedFrames = scailWindowFrames(frames - startFrame);
    const emittedFrames = generatedFrames - anchorFrames;
    // A 4n+1 tail no longer than the anchor adds nothing; another chunk cannot help.
    if (emittedFrames < 1) break;
    chunks.push(freezeRecord({ ordinal, startFrame, generatedFrames, anchorFrames, emittedFrames }));
    nextOffset = startFrame + SCAIL_CHUNK_FRAMES;
  }

  const emittedFrames = chunks.reduce((total, chunk) => total + chunk.emittedFrames, 0);
  const generatedFrames = chunks.reduce((total, chunk) => total + chunk.generatedFrames, 0);
  return Object.freeze({
    frames,
    chunkFrames: SCAIL_CHUNK_FRAMES,
    anchorFrames: SCAIL_ANCHOR_FRAMES,
    stepFrames: SCAIL_STEP_FRAMES,
    chunkCount: chunks.length,
    generatedFrames,
    emittedFrames,
    tailTrim: emittedFrames - frames,
    chunks: Object.freeze(chunks),
  });
}

function validatePlan(plan: ScailChunkPlan): void {
  if (!Object.isFrozen(plan) || !Object.isFrozen(plan.chunks) || plan.chunks.some(chunk => !Object.isFrozen(chunk))) {
    throw new Error("SCAIL-2 replace compiler requires a frozen plan");
  }
  const expected = planScailChunks(plan.frames);
  const scalarKeys: Array<Exclude<keyof ScailChunkPlan, "chunks">> = [
    "frames", "chunkFrames", "anchorFrames", "stepFrames", "chunkCount", "generatedFrames", "emittedFrames", "tailTrim",
  ];
  for (const key of scalarKeys) if (plan[key] !== expected[key]) throw new Error(`Invalid SCAIL-2 replace plan field: ${key}`);
  if (plan.chunks.length !== expected.chunks.length) throw new Error("Invalid SCAIL-2 replace plan chunks");
  for (let index = 0; index < expected.chunks.length; index += 1) {
    const actual = plan.chunks[index];
    const wanted = expected.chunks[index];
    if (!actual || Object.keys(wanted).some(key => actual[key as keyof ScailChunkRecord] !== wanted[key as keyof ScailChunkRecord])) {
      throw new Error(`Invalid SCAIL-2 replace chunk record: ${index}`);
    }
  }
}

function assertNodeClass(graph: ApiGraph, id: string, expectedClass: string): void {
  const node = graph[id];
  if (!node) throw new Error(`Missing SCAIL-2 replace node: ${id}`);
  if (node.class_type !== expectedClass) throw new Error(`SCAIL-2 replace class drift at ${id}: expected ${expectedClass}`);
}

/** The window is a parameter, never the clip length: the pose video is the whole
 *  clip and each chunk takes its own 81-frame slice from it. */
function requireWindowLength(graph: ApiGraph, id: string): void {
  const length = graph[id].inputs.length;
  if (length === SCAIL_CHUNK_FRAMES) return;
  const source = link(length);
  const primitive = source ? graph[source[0]] : undefined;
  if (primitive?.class_type === "PrimitiveInt" && primitive.inputs.value === SCAIL_CHUNK_FRAMES) return;
  throw new Error(`SCAIL-2 replace needs the ${id} window length fixed at ${SCAIL_CHUNK_FRAMES} frames; the template must not take it from the clip`);
}

/** WanSCAILToVideo centre-crops the character picture to the frame it renders, so a picture
 *  with another shape reaches the model as one middle slice: a two-view sheet arrives empty.
 *  The pack therefore cuts the character out with its SAM3 mask at the frame's own shape and
 *  hands the same crop to the mask, the CLIP vision and the reference latent.
 *  The node reads extra batch images as further views of the SAME identity ("composite all
 *  identities onto it"), so two separate pictures mix both faces onto both people (measured:
 *  6ede1bb6). Two people are therefore one frame holding both: each picture is cut out at half
 *  the frame's width, the first pasted on the left and the second on the right, both are tracked
 *  with SAM 3, and both colours come from that single frame (measured: 9313c646). A lazy switch
 *  keeps the reviewed single view for one person. */
function requireReferencePrep(graph: ApiGraph, condition: Record<string, unknown>): void {
  requireLink(graph["213:224"].inputs.track_data, "213:198", 0, "213:224.track_data");
  requireLink(graph["213:225"].inputs.images, "30", 0, "213:225.images");
  requireLink(graph["213:225"].inputs.masks, "213:224", 0, "213:225.masks");
  requireLink(graph["213:225"].inputs.width, "213:163", 0, "213:225.width");
  requireLink(graph["213:225"].inputs.height, "213:163", 1, "213:225.height");
  requireLink(graph["213:226"].inputs.mask, "213:224", 0, "213:226.mask");
  requireLink(graph["213:227"].inputs.images, "213:226", 0, "213:227.images");
  requireLink(graph["213:227"].inputs.masks, "213:224", 0, "213:227.masks");
  requireLink(graph["213:227"].inputs.width, "213:163", 0, "213:227.width");
  requireLink(graph["213:227"].inputs.height, "213:163", 1, "213:227.height");
  requireLink(graph["213:228"].inputs.image, "213:227", 0, "213:228.image");
  requireLink(graph["213:199"].inputs.ref_track_data, "213:228", 0, "213:199.ref_track_data");
  requireLink(condition.reference_image, IMAGE_SWITCH_NODE, 0, "213:114.reference_image");
  requireLink(condition.reference_image_mask, MASK_SWITCH_NODE, 0, "213:114.reference_image_mask");
  // CLIP vision reads the same picture the model does, so one person keeps the single crop.
  requireLink(graph["213:76"].inputs.image, IMAGE_SWITCH_NODE, 0, "213:76.image");
  requireLink(graph["213:76"].inputs.clip_vision, "213:75", 0, "213:76.clip_vision");
  requireSecondCharacter(graph, graph[IMAGE_SWITCH_NODE].inputs, graph[MASK_SWITCH_NODE].inputs);
}

/** The two-person branch, and the switch that keeps it out of a one-person run. */
function requireSecondCharacter(graph: ApiGraph, images: Record<string, unknown>, masks: Record<string, unknown>): void {
  const second = graph[TWO_PEOPLE_NODE].inputs.value;
  if (typeof second !== "boolean") throw new Error("SCAIL-2 replace two-person switch must be a boolean");
  // Off hands the model exactly the reviewed single view, the picture the first run measured.
  requireLink(images.on_false, "213:225", 0, `${IMAGE_SWITCH_NODE}.on_false`);
  requireLink(masks.on_false, "213:199", 1, `${MASK_SWITCH_NODE}.on_false`);
  requireLink(images.switch, TWO_PEOPLE_NODE, 0, `${IMAGE_SWITCH_NODE}.switch`);
  requireLink(masks.switch, TWO_PEOPLE_NODE, 0, `${MASK_SWITCH_NODE}.switch`);
  // On hands the model one frame holding both people, and both colours from that frame.
  requireLink(images.on_true, BOTH_CROP_NODE, 0, `${IMAGE_SWITCH_NODE}.on_true`);
  requireLink(masks.on_true, BOTH_COLOURS_CROP_NODE, 0, `${MASK_SWITCH_NODE}.on_true`);

  // Each picture is cut out at half the frame's width, so the two fit side by side in one frame.
  // The width is the frame's own, halved, so the composite arrives at the shape the model renders.
  const half = graph[HALF_WIDTH_NODE].inputs;
  if (half.expression !== "a / 2") throw new Error(`${HALF_WIDTH_NODE} must halve the frame width`);
  requireLink(half["values.a"], "213:163", 0, `${HALF_WIDTH_NODE}.width`);
  requireLink(graph[FIRST_HALF_NODE].inputs.images, "30", 0, `${FIRST_HALF_NODE}.images`);
  requireLink(graph[FIRST_HALF_NODE].inputs.masks, "213:224", 0, `${FIRST_HALF_NODE}.masks`);
  requireLink(graph[SECOND_HALF_NODE].inputs.images, SECOND_LOADER_NODE, 0, `${SECOND_HALF_NODE}.images`);
  requireLink(graph[SECOND_HALF_NODE].inputs.masks, SECOND_MASK_NODE, 0, `${SECOND_HALF_NODE}.masks`);
  for (const id of [FIRST_HALF_NODE, SECOND_HALF_NODE]) {
    requireLink(graph[id].inputs.width, HALF_WIDTH_NODE, 1, `${id}.width`);
    requireLink(graph[id].inputs.height, "213:163", 1, `${id}.height`);
  }

  // A black frame at the video's shape, the first person pasted on its left, the second on its right.
  const canvas = graph[BLACK_FRAME_NODE].inputs;
  requireLink(canvas.width, "213:163", 0, `${BLACK_FRAME_NODE}.width`);
  requireLink(canvas.height, "213:163", 1, `${BLACK_FRAME_NODE}.height`);
  if (canvas.color !== 0 || canvas.batch_size !== 1) throw new Error(`${BLACK_FRAME_NODE} must be one black frame`);
  const left = graph[FIRST_IN_FRAME_NODE].inputs;
  requireLink(left.destination, BLACK_FRAME_NODE, 0, `${FIRST_IN_FRAME_NODE}.destination`);
  requireLink(left.source, FIRST_HALF_NODE, 0, `${FIRST_IN_FRAME_NODE}.source`);
  if (left.x !== 0 || left.y !== 0) throw new Error(`${FIRST_IN_FRAME_NODE} must paste the first person at the frame's left edge`);
  const right = graph[BOTH_IN_ONE_FRAME_NODE].inputs;
  requireLink(right.destination, FIRST_IN_FRAME_NODE, 0, `${BOTH_IN_ONE_FRAME_NODE}.destination`);
  requireLink(right.source, SECOND_HALF_NODE, 0, `${BOTH_IN_ONE_FRAME_NODE}.source`);
  requireLink(right.x, HALF_WIDTH_NODE, 1, `${BOTH_IN_ONE_FRAME_NODE}.x`);
  if (right.y !== 0) throw new Error(`${BOTH_IN_ONE_FRAME_NODE} must paste the second person level with the first`);

  // Both people are tracked in that one frame: the crop that reaches the model and the two colours.
  requireLink(graph[BOTH_TRACK_NODE].inputs.images, BOTH_IN_ONE_FRAME_NODE, 0, `${BOTH_TRACK_NODE}.images`);
  requireLink(graph[BOTH_TRACK_NODE].inputs.model, "213:193", 0, `${BOTH_TRACK_NODE}.model`);
  requireLink(graph[BOTH_TRACK_NODE].inputs.conditioning, "213:212", 0, `${BOTH_TRACK_NODE}.conditioning`);
  requireLink(graph[BOTH_MASK_NODE].inputs.track_data, BOTH_TRACK_NODE, 0, `${BOTH_MASK_NODE}.track_data`);
  if (graph[BOTH_MASK_NODE].inputs.object_indices !== "0,1") throw new Error(`${BOTH_MASK_NODE} must hold both people`);
  requireLink(graph[BOTH_CROP_NODE].inputs.images, BOTH_IN_ONE_FRAME_NODE, 0, `${BOTH_CROP_NODE}.images`);
  requireLink(graph[BOTH_CROP_NODE].inputs.masks, BOTH_MASK_NODE, 0, `${BOTH_CROP_NODE}.masks`);
  requireLink(graph[BOTH_CROP_NODE].inputs.width, "213:163", 0, `${BOTH_CROP_NODE}.width`);
  requireLink(graph[BOTH_CROP_NODE].inputs.height, "213:163", 1, `${BOTH_CROP_NODE}.height`);
  // The coloured mask must undergo exactly the same spatial transform as its
  // image; equal output dimensions alone do not align the subject regions.
  const maskCrop = graph[BOTH_COLOURS_CROP_NODE].inputs;
  requireLink(maskCrop.images, BOTH_COLOURS_NODE, 1, `${BOTH_COLOURS_CROP_NODE}.images`);
  requireLink(maskCrop.masks, BOTH_MASK_NODE, 0, `${BOTH_COLOURS_CROP_NODE}.masks`);
  for (const key of ["width", "height", "pad_factor", "grow_mask", "background"]) {
    if (JSON.stringify(maskCrop[key]) !== JSON.stringify(graph[BOTH_CROP_NODE].inputs[key])) {
      throw new Error("SCAIL-2 reference image and coloured mask must use the same crop geometry");
    }
  }
  const colours = graph[BOTH_COLOURS_NODE].inputs;
  requireLink(colours.driving_track_data, "213:196", 0, `${BOTH_COLOURS_NODE}.driving_track_data`);
  requireLink(colours.ref_track_data, BOTH_TRACK_NODE, 0, `${BOTH_COLOURS_NODE}.ref_track_data`);
  requireLink(colours.replacement_mode, "213:203", 0, `${BOTH_COLOURS_NODE}.replacement_mode`);
  // The leftmost person in the frame keeps the first colour, in the video and in the reference alike.
  if (colours.object_indices !== "0,1" || colours.sort_by !== "left_to_right") {
    throw new Error(`${BOTH_COLOURS_NODE} must paint both identities left to right`);
  }

  // The second picture is tracked and cut out for its own half of the frame.
  requireLink(graph[SECOND_TRACK_NODE].inputs.images, SECOND_LOADER_NODE, 0, `${SECOND_TRACK_NODE}.images`);
  requireLink(graph[SECOND_MASK_NODE].inputs.track_data, SECOND_TRACK_NODE, 0, `${SECOND_MASK_NODE}.track_data`);
  if (graph[SECOND_MASK_NODE].inputs.object_indices !== "0" || graph[SECOND_LOADER_NODE].inputs.image === undefined) {
    throw new Error("SCAIL-2 replace second character must be one masked picture");
  }
}


function assertExclusiveConsumers(graph: ApiGraph, producer: string, allowed: Record<string, Record<string, [string, number]>>): void {
  for (const [id, node] of Object.entries(graph)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      const source = link(value);
      if (source?.[0] !== producer) continue;
      const expected = allowed[id]?.[field];
      if (!expected || expected[1] !== source[1]) throw new Error(`Unexpected consumer of ${producer}: ${id}.${field}`);
    }
  }
}

function validateBaseGraph(graph: ApiGraph): void {
  for (const id of Object.keys(graph)) {
    if (id === SCAIL_BATCH_NODE_ID || id === SCAIL_FINAL_CROP_NODE_ID || id.startsWith("replace:")) {
      throw new Error(`SCAIL-2 replace compiler node collision: ${id}`);
    }
  }
  for (const [id, node] of Object.entries(graph)) {
    if (/preview|compare/i.test(node.class_type)) throw new Error(`Comparison or preview node is not allowed: ${id}`);
  }

  assertNodeClass(graph, CONDITION_NODE, "WanSCAILToVideo");
  assertNodeClass(graph, SAMPLER_NODE, "SamplerCustom");
  assertNodeClass(graph, DECODE_NODE, "VAEDecode");
  assertNodeClass(graph, "213:7", "VAELoader");
  assertNodeClass(graph, "213:156", "ResizeImageMaskNode");
  assertNodeClass(graph, "213:900", "ResizeImageMaskNode");
  assertNodeClass(graph, "213:197", "SCAIL2ColoredMask");
  assertNodeClass(graph, "30", "LoadImage");
  assertNodeClass(graph, "213:198", "SAM3_VideoTrack");
  assertNodeClass(graph, "213:224", "SAM3_TrackToMask");
  assertNodeClass(graph, "213:225", "ImageCropToMask");
  assertNodeClass(graph, "213:226", "MaskToImage");
  assertNodeClass(graph, "213:227", "ImageCropToMask");
  assertNodeClass(graph, "213:228", "ImageToMask");
  assertNodeClass(graph, "213:76", "CLIPVisionEncode");
  assertNodeClass(graph, SECOND_LOADER_NODE, "LoadImage");
  assertNodeClass(graph, SECOND_TRACK_NODE, "SAM3_VideoTrack");
  assertNodeClass(graph, SECOND_MASK_NODE, "SAM3_TrackToMask");
  assertNodeClass(graph, BLACK_FRAME_NODE, "EmptyImage");
  assertNodeClass(graph, FIRST_IN_FRAME_NODE, "ImageCompositeMasked");
  assertNodeClass(graph, FIRST_HALF_NODE, "ImageCropToMask");
  assertNodeClass(graph, SECOND_HALF_NODE, "ImageCropToMask");
  assertNodeClass(graph, BOTH_IN_ONE_FRAME_NODE, "ImageCompositeMasked");
  assertNodeClass(graph, HALF_WIDTH_NODE, "ComfyMathExpression");
  assertNodeClass(graph, BOTH_TRACK_NODE, "SAM3_VideoTrack");
  assertNodeClass(graph, BOTH_MASK_NODE, "SAM3_TrackToMask");
  assertNodeClass(graph, BOTH_CROP_NODE, "ImageCropToMask");
  assertNodeClass(graph, BOTH_COLOURS_NODE, "SCAIL2ColoredMask");
  assertNodeClass(graph, BOTH_COLOURS_CROP_NODE, "ImageCropToMask");
  assertNodeClass(graph, IMAGE_SWITCH_NODE, "ComfySwitchNode");
  assertNodeClass(graph, MASK_SWITCH_NODE, "ComfySwitchNode");
  assertNodeClass(graph, TWO_PEOPLE_NODE, "PrimitiveBoolean");
  assertNodeClass(graph, "201", "CreateVideo");
  assertNodeClass(graph, "202", "SaveVideo");

  const createNodes = Object.entries(graph).filter(([, node]) => node.class_type === "CreateVideo");
  const saveNodes = Object.entries(graph).filter(([, node]) => node.class_type === "SaveVideo");
  if (createNodes.length !== 1 || createNodes[0]?.[0] !== "201") throw new Error("SCAIL-2 replace requires exactly one CreateVideo node at 201");
  if (saveNodes.length !== 1 || saveNodes[0]?.[0] !== "202") throw new Error("SCAIL-2 replace requires exactly one SaveVideo node at 202");
  requireLink(graph["202"].inputs.video, "201", 0, "202.video");

  const condition = graph[CONDITION_NODE].inputs;
  requireWindowLength(graph, CONDITION_NODE);
  if (condition.previous_frame_count !== SCAIL_ANCHOR_FRAMES) throw new Error(`SCAIL-2 replace anchor count must be ${SCAIL_ANCHOR_FRAMES}`);
  if (condition.video_frame_offset !== 0) throw new Error("First SCAIL-2 replace chunk offset must be zero");
  if ("previous_frames" in condition) throw new Error("First SCAIL-2 replace chunk cannot continue previous frames");
  requireLink(condition.pose_video, "213:156", 0, "213:114.pose_video");
  requireLink(condition.pose_video_mask, "213:197", 0, "213:114.pose_video_mask");
  requireLink(condition.vae, "213:7", 0, "213:114.vae");
  requireReferencePrep(graph, condition);

  requireLink(graph["213:156"].inputs.input, "213:900", 0, "213:156.input");
  if (!linkEquals(graph["213:900"].inputs.input, "213:157", 0)) {
    throw new Error("SCAIL-2 replace needs the whole clip in pose_video: 213:900 must resample 213:157, not a sliced batch");
  }

  requireLink(graph[SAMPLER_NODE].inputs.positive, CONDITION_NODE, 0, "213:19.positive");
  requireLink(graph[SAMPLER_NODE].inputs.negative, CONDITION_NODE, 1, "213:19.negative");
  requireLink(graph[SAMPLER_NODE].inputs.latent_image, CONDITION_NODE, 2, "213:19.latent_image");
  requireLink(graph[DECODE_NODE].inputs.samples, SAMPLER_NODE, 1, "213:6.samples");
  requireLink(graph[DECODE_NODE].inputs.vae, "213:7", 0, "213:6.vae");
  requireLink(graph["201"].inputs.images, DECODE_NODE, 0, "201.images");

  // Only the sampler reads the condition node, and only CreateVideo reads the decode.
  // Anything else would silently keep watching chunk zero after the clone.
  assertExclusiveConsumers(graph, CONDITION_NODE, {
    [SAMPLER_NODE]: { positive: [CONDITION_NODE, 0], negative: [CONDITION_NODE, 1], latent_image: [CONDITION_NODE, 2] },
  });
  assertExclusiveConsumers(graph, DECODE_NODE, { "201": { images: [DECODE_NODE, 0] } });

  assertLocalGraphPolicy(graph);
}

function chunkNodeId(ordinal: number, suffix: (typeof CLONE_SUFFIXES)[number]): string {
  return ordinal === 0 ? `${TEMPLATE_PREFIX}${suffix}` : `replace:${ordinal}:${suffix}`;
}

function joinNodeId(ordinal: number): string {
  return `replace:${ordinal}:join`;
}

function rewriteCloneLinks(value: unknown, ordinal: number): unknown {
  if (Array.isArray(value)) {
    const source = link(value);
    if (source && CLONE_SOURCES.has(source[0])) {
      const suffix = source[0].slice(TEMPLATE_PREFIX.length) as (typeof CLONE_SUFFIXES)[number];
      return [chunkNodeId(ordinal, suffix), source[1]];
    }
    return value.map(item => rewriteCloneLinks(item, ordinal));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteCloneLinks(item, ordinal)]));
  }
  return value;
}

function validateCompiledChunk(graph: ApiGraph, record: ScailChunkRecord): void {
  const { ordinal } = record;
  const conditionId = chunkNodeId(ordinal, "114");
  assertNodeClass(graph, conditionId, "WanSCAILToVideo");
  assertNodeClass(graph, chunkNodeId(ordinal, "19"), "SamplerCustom");
  assertNodeClass(graph, chunkNodeId(ordinal, "6"), "VAEDecode");
  requireWindowLength(graph, conditionId);
  requireLink(graph[chunkNodeId(ordinal, "19")].inputs.positive, conditionId, 0, `${chunkNodeId(ordinal, "19")}.positive`);
  requireLink(graph[chunkNodeId(ordinal, "19")].inputs.negative, conditionId, 1, `${chunkNodeId(ordinal, "19")}.negative`);
  requireLink(graph[chunkNodeId(ordinal, "19")].inputs.latent_image, conditionId, 2, `${chunkNodeId(ordinal, "19")}.latent_image`);
  requireLink(graph[chunkNodeId(ordinal, "6")].inputs.samples, chunkNodeId(ordinal, "19"), 1, `${chunkNodeId(ordinal, "6")}.samples`);

  const condition = graph[conditionId].inputs;
  if (condition.previous_frame_count !== SCAIL_ANCHOR_FRAMES) throw new Error(`Compiled SCAIL-2 replace chunk ${ordinal} anchor count drift`);
  if (ordinal === 0) {
    if ("previous_frames" in condition || condition.video_frame_offset !== 0) {
      throw new Error("Compiled first SCAIL-2 replace chunk has continuation state");
    }
    if (record.startFrame !== 0) throw new Error("Compiled first SCAIL-2 replace chunk must start at frame zero");
    return;
  }

  requireLink(condition.video_frame_offset, chunkNodeId(ordinal - 1, "114"), 3, `${conditionId}.video_frame_offset`);
  requireLink(condition.previous_frames, chunkNodeId(ordinal - 1, "6"), 0, `${conditionId}.previous_frames`);
  if (record.startFrame !== SCAIL_STEP_FRAMES * ordinal) throw new Error(`Compiled SCAIL-2 replace chunk ${ordinal} start frame drift`);

  const join = graph[joinNodeId(ordinal)];
  if (join?.class_type !== "ImageFromBatch") throw new Error(`Missing SCAIL-2 replace join slice: ${joinNodeId(ordinal)}`);
  requireLink(join.inputs.image, chunkNodeId(ordinal, "6"), 0, `${joinNodeId(ordinal)}.image`);
  if (join.inputs.batch_index !== SCAIL_ANCHOR_FRAMES) throw new Error(`Compiled SCAIL-2 replace chunk ${ordinal} join index drift`);
  if (join.inputs.length !== record.emittedFrames) throw new Error(`Compiled SCAIL-2 replace chunk ${ordinal} join length drift`);
}

function validateCompiledGraph(graph: ApiGraph, baseGraph: ApiGraph, plan: ScailChunkPlan): void {
  for (const record of plan.chunks) validateCompiledChunk(graph, record);
  if (plan.chunkCount === 1) {
    // One window needs no extra node: the reviewed graph already renders it as is.
    if (Object.keys(graph).length !== Object.keys(baseGraph).length) throw new Error("Compiled SCAIL-2 replace single chunk membership drift");
    requireLink(graph["201"].inputs.images, DECODE_NODE, 0, "201.images");
    assertLocalGraphPolicy(graph);
    return;
  }

  const batch = graph[SCAIL_BATCH_NODE_ID];
  if (batch?.class_type !== "BatchImagesNode") throw new Error("Compiled SCAIL-2 replace graph must contain one BatchImagesNode");
  const members = Object.entries(batch.inputs);
  if (members.length !== plan.chunkCount) throw new Error("Compiled SCAIL-2 replace batch membership drift");
  for (const record of plan.chunks) {
    const expected = record.ordinal === 0 ? DECODE_NODE : joinNodeId(record.ordinal);
    if (!linkEquals(batch.inputs[`images.image${record.ordinal}`], expected, 0)) throw new Error("Compiled SCAIL-2 replace batch membership drift");
  }

  const crop = graph[SCAIL_FINAL_CROP_NODE_ID];
  if (crop?.class_type !== "ImageFromBatch") throw new Error("Compiled SCAIL-2 replace graph must contain the final crop");
  requireLink(crop.inputs.image, SCAIL_BATCH_NODE_ID, 0, `${SCAIL_FINAL_CROP_NODE_ID}.image`);
  if (crop.inputs.batch_index !== 0 || crop.inputs.length !== plan.frames) throw new Error("Compiled SCAIL-2 replace final crop drift");
  requireLink(graph["201"].inputs.images, SCAIL_FINAL_CROP_NODE_ID, 0, "201.images");

  const expectedIds = Object.keys(baseGraph).length + (plan.chunkCount - 1) * (CLONE_SUFFIXES.length + 1) + 2;
  if (Object.keys(graph).length !== expectedIds) throw new Error("Compiled SCAIL-2 replace graph membership drift");
  if (Object.values(graph).filter(node => node.class_type === "CreateVideo").length !== 1) throw new Error("Compiled SCAIL-2 replace graph must contain one CreateVideo");
  if (Object.values(graph).filter(node => node.class_type === "SaveVideo").length !== 1) throw new Error("Compiled SCAIL-2 replace graph must contain one SaveVideo");
  assertLocalGraphPolicy(graph);
}

/**
 * Expand a reviewed SCAIL-2 replace graph into one chained pass per 81-frame window.
 * Only the condition, sampler and decode nodes are cloned per chunk, so the model,
 * LoRA and SAM 3 work still runs once. This only constructs graph JSON; it does not
 * establish runtime readiness or measure the seams between chunks.
 */
export function compileScailChunks(baseGraph: ApiGraph, plan: ScailChunkPlan): ApiGraph {
  validatePlan(plan);
  validateBaseGraph(baseGraph);

  const graph: ApiGraph = structuredClone(baseGraph);
  if (plan.chunkCount > 1) {
    for (let ordinal = 1; ordinal < plan.chunkCount; ordinal += 1) {
      for (const suffix of CLONE_SUFFIXES) {
        const baseNode = structuredClone(baseGraph[`${TEMPLATE_PREFIX}${suffix}`]);
        graph[chunkNodeId(ordinal, suffix)] = {
          ...baseNode,
          inputs: rewriteCloneLinks(baseNode.inputs, ordinal) as Record<string, unknown>,
        };
      }

      const condition = graph[chunkNodeId(ordinal, "114")].inputs;
      condition.video_frame_offset = [chunkNodeId(ordinal - 1, "114"), 3];
      condition.previous_frames = [chunkNodeId(ordinal - 1, "6"), 0];

      graph[joinNodeId(ordinal)] = {
        class_type: "ImageFromBatch",
        inputs: {
          image: [chunkNodeId(ordinal, "6"), 0],
          batch_index: SCAIL_ANCHOR_FRAMES,
          length: plan.chunks[ordinal].emittedFrames,
        },
      };
    }

    graph[SCAIL_BATCH_NODE_ID] = {
      class_type: "BatchImagesNode",
      inputs: Object.fromEntries(
        plan.chunks.map(chunk => [`images.image${chunk.ordinal}`, chunk.ordinal === 0 ? [DECODE_NODE, 0] : [joinNodeId(chunk.ordinal), 0]]),
      ),
    };
    graph[SCAIL_FINAL_CROP_NODE_ID] = {
      class_type: "ImageFromBatch",
      inputs: { image: [SCAIL_BATCH_NODE_ID, 0], batch_index: 0, length: plan.frames },
    };
    graph["201"].inputs.images = [SCAIL_FINAL_CROP_NODE_ID, 0];
  }

  validateCompiledGraph(graph, baseGraph, plan);
  return graph;
}

/** A cloned window's node id: replace:1:19 is the second window's sampler. */
const CHUNK_NODE = /^replace:(\d+):/;

export type ReplacePart = { part: number; parts: number };

/** Which window a running node belongs to, and how many windows the graph holds. The compiler clones
 *  every later window under replace:N, so the node id itself says the part, and a graph with no such
 *  node was not chained and has no parts to name. The template's own nodes run with the first window;
 *  work shared by the whole job under its own id (the models, the mask tracking) belongs to no window. */
export function scailChunkParts(
  graph: Record<string, unknown> | null | undefined,
  node: string | null | undefined,
): ReplacePart | undefined {
  if (!graph || !node) return undefined;
  let last = 0;
  for (const id of Object.keys(graph)) {
    const match = CHUNK_NODE.exec(id);
    if (match) last = Math.max(last, Number(match[1]));
  }
  if (last < 1) return undefined;
  const own = CHUNK_NODE.exec(node);
  const ordinal = own ? Number(own[1]) : node.startsWith(TEMPLATE_PREFIX) ? 0 : undefined;
  if (ordinal === undefined || ordinal > last) return undefined;
  return { part: ordinal + 1, parts: last + 1 };
}

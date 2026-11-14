import type { ApiGraph } from "../workflow/build";
import { assertLocalGraphPolicy } from "./policy";

/** Local Openjutsu-style replace renders the clip in relay windows: each window carries the
 *  first frame the pass before it produced, so the character cannot drift between windows. */
export const JUTSU_WINDOW_FRAMES = 81;
/** The seam frame a later window repeats: its first decoded frame is the one before it ended on. */
export const JUTSU_OVERLAP_FRAMES = 1;
export const JUTSU_STEP_FRAMES = JUTSU_WINDOW_FRAMES - JUTSU_OVERLAP_FRAMES;
export const JUTSU_MAX_WINDOWS = 2;
/** Two windows, each adding 80 new frames: 161 frames is the honest ceiling. */
export const JUTSU_MAX_FRAMES = JUTSU_WINDOW_FRAMES + JUTSU_STEP_FRAMES * (JUTSU_MAX_WINDOWS - 1);

/** Template nodes the reviewed graph is pinned to. The anchor, the relay windows and the
 *  composite are all in the pack; the compiler only sets lengths and drops the second window. */
export const JUTSU_CROP_NODE_ID = "crop";
export const JUTSU_MASK_SLICE_NODE_ID = "maskSlice";
export const JUTSU_BATCH_NODE_ID = "289";
export const JUTSU_FIRST_WINDOW_NODE = "261:247";
export const JUTSU_SECOND_WINDOW_PREFIX = "w1:";
export const JUTSU_ARTIFACT_NODE = "246";

export type JutsuWindowRecord = Readonly<{
  ordinal: number;
  /** Source frame this window starts at. A later window repeats one frame the one before it produced. */
  startFrame: number;
  /** Window length after the node's 4n+1 rounding. */
  generatedFrames: number;
  overlapFrames: 0 | typeof JUTSU_OVERLAP_FRAMES;
  /** New frames this window adds to the joined video. */
  emittedFrames: number;
}>;

export type JutsuRelayPlan = Readonly<{
  frames: number;
  windowFrames: typeof JUTSU_WINDOW_FRAMES;
  overlapFrames: typeof JUTSU_OVERLAP_FRAMES;
  stepFrames: number;
  /** The window ceiling this plan was made for; the pack declares it. */
  maxWindows: number;
  windowCount: number;
  generatedFrames: number;
  emittedFrames: number;
  /** The frames the run actually publishes: the clip's length, or what the windows reach. */
  outputFrames: number;
  /** emittedFrames - frames. Positive is what the final crop drops. Negative means the 4n+1
   *  rounding cannot reach the last source frames (at most 3). */
  tailTrim: number;
  windows: readonly JutsuWindowRecord[];
}>;

/** Wan Animate 2 cuts its motion to ((min(rest, 81) - 1) / 4) * 4 + 1 frames. */
export function jutsuWindowFrames(available: number): number {
  return Math.floor((Math.min(available, JUTSU_WINDOW_FRAMES) - 1) / 4) * 4 + 1;
}

/** The longest clip a given number of relay windows reaches. */
export function relayCeilingFrames(maxWindows: number): number {
  return JUTSU_WINDOW_FRAMES + JUTSU_STEP_FRAMES * (Math.max(1, Math.min(maxWindows, JUTSU_MAX_WINDOWS)) - 1);
}

export function planJutsuRelay(frames: number, maxWindows: number = JUTSU_MAX_WINDOWS): JutsuRelayPlan {
  if (!Number.isSafeInteger(frames) || frames < 1) {
    throw new Error("Local jutsu replace frame count must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxWindows) || maxWindows < 1 || maxWindows > JUTSU_MAX_WINDOWS) {
    throw new Error(`Local jutsu replace runs one to ${JUTSU_MAX_WINDOWS} relay windows`);
  }
  const ceiling = relayCeilingFrames(maxWindows);
  if (frames > ceiling) {
    throw new Error(`Local jutsu replace supports at most ${maxWindows} relay window${maxWindows === 1 ? "" : "s"} (${ceiling} frames)`);
  }

  const windows: JutsuWindowRecord[] = [];
  let nextStart = 0;
  while (nextStart < frames && windows.length < maxWindows) {
    const ordinal = windows.length;
    const overlapFrames = ordinal === 0 ? 0 : JUTSU_OVERLAP_FRAMES;
    // A later window repeats the frame the one before it ended on, so it renders that frame once more.
    const wanted = frames - nextStart + overlapFrames;
    const generatedFrames = jutsuWindowFrames(wanted);
    const emittedFrames = generatedFrames - overlapFrames;
    // A 4n+1 tail no longer than the overlap adds nothing; another window cannot help.
    if (emittedFrames < 1) break;
    windows.push(Object.freeze({ ordinal, startFrame: nextStart, generatedFrames, overlapFrames, emittedFrames }));
    nextStart += emittedFrames;
  }

  const generatedFrames = windows.reduce((total, window) => total + window.generatedFrames, 0);
  const emittedFrames = windows.reduce((total, window) => total + window.emittedFrames, 0);
  return Object.freeze({
    frames,
    windowFrames: JUTSU_WINDOW_FRAMES,
    overlapFrames: JUTSU_OVERLAP_FRAMES,
    stepFrames: JUTSU_STEP_FRAMES,
    maxWindows,
    windowCount: windows.length,
    generatedFrames,
    emittedFrames,
    outputFrames: Math.min(frames, emittedFrames),
    tailTrim: emittedFrames - frames,
    windows: Object.freeze(windows),
  });
}

function assertNodeClass(graph: ApiGraph, id: string, expectedClass: string): void {
  const node = graph[id];
  if (!node) throw new Error(`Missing local jutsu replace node: ${id}`);
  if (node.class_type !== expectedClass) throw new Error(`Local jutsu replace class drift at ${id}: expected ${expectedClass}`);
}

function requireLink(value: unknown, node: string, output: number, label: string): void {
  const link = Array.isArray(value) && value.length === 2 ? value : undefined;
  if (!link || link[0] !== node || link[1] !== output) throw new Error(`Invalid local jutsu replace link: ${label}`);
}

/** The single relay window the reviewed anchor, mask and composite are built around. */
function validateBaseGraph(graph: ApiGraph): void {
  for (const id of Object.keys(graph)) {
    if (/preview|compare/i.test(graph[id].class_type)) throw new Error(`Comparison or preview node is not allowed: ${id}`);
  }
  assertNodeClass(graph, JUTSU_FIRST_WINDOW_NODE, "WanAnimate2ToVideo");
  assertNodeClass(graph, `261:6`, "VAEDecode");
  assertNodeClass(graph, "261:19", "SamplerCustom");
  assertNodeClass(graph, `${JUTSU_SECOND_WINDOW_PREFIX}247`, "WanAnimate2ToVideo");
  assertNodeClass(graph, `${JUTSU_SECOND_WINDOW_PREFIX}6`, "VAEDecode");
  assertNodeClass(graph, `${JUTSU_SECOND_WINDOW_PREFIX}299`, "ComfySwitchNode");
  assertNodeClass(graph, JUTSU_BATCH_NODE_ID, "BatchImagesNode");
  assertNodeClass(graph, JUTSU_CROP_NODE_ID, "ImageFromBatch");
  assertNodeClass(graph, "compose", "ImageCompositeMasked");
  assertNodeClass(graph, "sourceSlice", "ImageFromBatch");
  assertNodeClass(graph, JUTSU_MASK_SLICE_NODE_ID, "ImageFromBatch");
  assertNodeClass(graph, JUTSU_ARTIFACT_NODE, "SaveVideo");

  // The second window continues the first rather than starting again.
  requireLink(graph[`${JUTSU_SECOND_WINDOW_PREFIX}247`].inputs.continue_motion, "261:6", 0, "w1:247.continue_motion");
  requireLink(graph[`${JUTSU_SECOND_WINDOW_PREFIX}247`].inputs.video_frame_offset, JUTSU_FIRST_WINDOW_NODE, 3, "w1:247.video_frame_offset");
  // The seam frame is dropped, not shown twice.
  requireLink(graph[`${JUTSU_SECOND_WINDOW_PREFIX}299`].inputs.on_true, `${JUTSU_SECOND_WINDOW_PREFIX}298`, 0, "w1:299.on_true");
  // The render only supplies the person; every other pixel is the source clip's.
  requireLink(graph["compose"].inputs.destination, "sourceSlice", 0, "compose.destination");
  requireLink(graph["sourceSlice"].inputs.image, "2", 0, "sourceSlice.image");
  requireLink(graph["compose"].inputs.source, JUTSU_CROP_NODE_ID, 0, "compose.source");
  requireLink(graph["compose"].inputs.mask, "maskSliceBack", 0, "compose.mask");
  requireLink(graph["maskSliceBack"].inputs.image, JUTSU_MASK_SLICE_NODE_ID, 0, "maskSliceBack.image");
  requireLink(graph["maskSlice"].inputs.image, "maskImage", 0, "maskSlice.image");
  requireLink(graph["245"].inputs.images, "compose", 0, "245.images");

  assertLocalGraphPolicy(graph);
}

/**
 * Bind a reviewed local jutsu replace graph to one clip. The anchor, the mask and the relay
 * wiring stay as reviewed; only the lengths follow the clip and, for a clip that fits one
 * window, the second window leaves the batch. This only constructs graph JSON.
 */
export function compileJutsuRelay(baseGraph: ApiGraph, plan: JutsuRelayPlan): ApiGraph {
  const expected = planJutsuRelay(plan.frames, plan.maxWindows);
  if (!Object.isFrozen(plan) || !Object.isFrozen(plan.windows)) throw new Error("Local jutsu replace compiler requires a frozen plan");
  for (const key of ["maxWindows", "windowCount", "generatedFrames", "emittedFrames", "outputFrames", "tailTrim"] as const) {
    if (plan[key] !== expected[key]) throw new Error(`Invalid local jutsu replace plan field: ${key}`);
  }
  validateBaseGraph(baseGraph);

  const graph: ApiGraph = structuredClone(baseGraph);
  const first = plan.windows[0];
  graph[JUTSU_FIRST_WINDOW_NODE].inputs.length = first.generatedFrames;
  graph[JUTSU_CROP_NODE_ID].inputs.length = plan.outputFrames;
  graph[JUTSU_MASK_SLICE_NODE_ID].inputs.length = plan.outputFrames;
  graph["sourceSlice"].inputs.length = plan.outputFrames;

  if (plan.windowCount === 1) {
    const batch = graph[JUTSU_BATCH_NODE_ID];
    delete batch.inputs["images.image1"];
    for (const id of Object.keys(graph)) if (id.startsWith(JUTSU_SECOND_WINDOW_PREFIX)) delete graph[id];
  } else {
    const second = plan.windows[1];
    graph[`${JUTSU_SECOND_WINDOW_PREFIX}247`].inputs.length = second.generatedFrames;
    graph[`${JUTSU_SECOND_WINDOW_PREFIX}298`].inputs.length = second.generatedFrames;
    // Both windows are the same run, so they share the run's seed rather than the template's.
    graph[`${JUTSU_SECOND_WINDOW_PREFIX}19`].inputs.noise_seed = graph["261:19"].inputs.noise_seed;
    requireLink(graph[JUTSU_BATCH_NODE_ID].inputs["images.image1"], `${JUTSU_SECOND_WINDOW_PREFIX}299`, 0, "289.images.image1");
    requireLink(graph[JUTSU_BATCH_NODE_ID].inputs["images.image0"], "261:299", 0, "289.images.image0");
  }

  if (Object.values(graph).filter(node => node.class_type === "SaveVideo").length !== 1) {
    throw new Error("Local jutsu replace graph must contain one SaveVideo");
  }
  assertLocalGraphPolicy(graph);
  return graph;
}

/** Whether a plan keeps every source frame; a 4n+1 tail can fall up to three frames short. */
export function jutsuPlanLosesTail(plan: JutsuRelayPlan): boolean {
  return plan.tailTrim < 0;
}




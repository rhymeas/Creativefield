import type {ApiGraph} from "../workflow/build";
import {compileLocal} from "./compile";
import {assertLocalGraphPolicy} from "./policy";
import type {CapabilityBundle, Invocation} from "./types";

/* The video step after the still is approved. The approved still is the reference frame, the
   clip's own skeleton is the motion, and the render is composited back over the clean clip
   through each person's mask, so the wall, the microphone and the light stay the clip's pixels.
   SDPose draws one person per pass, so the reviewed graph poses each person on their own SAM 3
   mask and puts the two skeletons back on one black canvas. The compiler only sets the window
   length and the words: the anchor, the masks and the composite stay as reviewed. */

const CLIP="1", UNION="6", MASK_LEFT="maskL", MASK_RIGHT="maskR", CANVAS="canvas";
const WINDOW="261:247", MASK_SLICE="maskSlice", SOURCE_SLICE="sourceSlice", RENDER_CROP="crop";
const SCENE="605", MOTION="604", ARTIFACT="246";

/** Wan Animate 2 animates at most 81 frames in one window, and rounds the cut to 4n+1. */
export const FROM_STILL_MAX_FRAMES = 81;
export const FROM_STILL_FPS = 24;

/** The scene the anchor still shows. The picture decides the people; these words only pin the
 *  place, so an empty control still asks for the studio and not for a new scene. */
const BASE_SCENE = "Two men talk to each other in an orange studio with a microphone between them. Plain orange wall, soft studio light, steady camera.";
const BASE_MOTION = "Both men talk and gesture at each other, small movements, steady camera.";

export function fromStillScene(extra = ""): string {
  const note = extra.trim();
  return note ? `${BASE_SCENE}\n\n${note}` : BASE_SCENE;
}

export function fromStillMotion(extra = ""): string {
  const note = extra.trim();
  return note ? `${BASE_MOTION}\n\n${note}` : BASE_MOTION;
}

/** Wan Animate 2 cuts its motion to ((min(rest, 81) - 1) / 4) * 4 + 1 frames. */
export function fromStillWindowFrames(available: number): number {
  if (!Number.isSafeInteger(available) || available < 1) throw new Error("Frame count must be a positive whole number");
  return Math.floor((Math.min(available, FROM_STILL_MAX_FRAMES) - 1) / 4) * 4 + 1;
}

function node(graph: ApiGraph, id: string, expected: string): ApiGraph[string] {
  const found = graph[id];
  if (!found) throw new Error(`Missing replace-from-still node: ${id}`);
  if (found.class_type !== expected) throw new Error(`Replace-from-still class drift at ${id}: expected ${expected}`);
  return found;
}

/** Every length in the window follows one number: the render, the mask slices, the source slice,
 *  the black canvas the two skeletons are drawn on, and the crop the composite takes. */
function setWindowFrames(graph: ApiGraph, frames: number): void {
  node(graph, WINDOW, "WanAnimate2ToVideo").inputs.length = frames;
  node(graph, MASK_SLICE, "ImageFromBatch").inputs.length = frames;
  node(graph, SOURCE_SLICE, "ImageFromBatch").inputs.length = frames;
  node(graph, RENDER_CROP, "ImageFromBatch").inputs.length = frames;
  node(graph, "maskSliceL", "ImageFromBatch").inputs.length = frames;
  node(graph, "maskSliceR", "ImageFromBatch").inputs.length = frames;
  node(graph, CANVAS, "EmptyImage").inputs.batch_size = frames;
}

/** The reviewed wiring the compiler insists on before it writes anything. */
function checkWiring(graph: ApiGraph): void {
  const link = (value: unknown, id: string, slot = 0) => Array.isArray(value) && value[0] === id && value[1] === slot;
  node(graph, CLIP, "LoadVideo");
  node(graph, UNION, "SAM3_TrackToMask");
  node(graph, MASK_LEFT, "SAM3_TrackToMask");
  node(graph, MASK_RIGHT, "SAM3_TrackToMask");
  if (!link(graph[MASK_LEFT].inputs.track_data, "5") || !link(graph[MASK_RIGHT].inputs.track_data, "5")) throw new Error("Replace-from-still masks must both read the clip's person track");
  if (graph[MASK_LEFT].inputs.object_indices === graph[MASK_RIGHT].inputs.object_indices) throw new Error("Replace-from-still needs one mask per person");
  // Each person is posed on their own mask, and the two skeletons land on one canvas.
  node(graph, "kpL", "SDPoseKeypointExtractor");
  node(graph, "kpR", "SDPoseKeypointExtractor");
  if (!link(graph["kpL"].inputs.image, "isoL") || !link(graph["kpR"].inputs.image, "isoR")) throw new Error("Replace-from-still poses each person on their own mask");
  // The window's masks and frames are sliced first, so a long clip is not composited frame for frame.
  if (!link(graph["isoL"].inputs.source, SOURCE_SLICE) || !link(graph["isoR"].inputs.source, SOURCE_SLICE)) throw new Error("Replace-from-still isolates people from the window's own frames");
  if (!link(graph["isoL"].inputs.mask, "maskBackL") || !link(graph["isoR"].inputs.mask, "maskBackR")) throw new Error("Replace-from-still isolates each person with their own sliced mask");
  if (!link(graph["poseBoth"].inputs.mask, "maskBackR") || !link(graph["poseBoth"].inputs.destination, "poseL")) throw new Error("Replace-from-still must draw both skeletons on one canvas");
  if (!link(graph["261:243"].inputs.input, "poseBoth")) throw new Error("Replace-from-still must animate from the two-person skeleton");
  // The render only supplies the people; every other pixel is the clean clip's.
  node(graph, "compose", "ImageCompositeMasked");
  if (!link(graph["compose"].inputs.destination, SOURCE_SLICE) || !link(graph["compose"].inputs.mask, "maskSliceBack")) throw new Error("Replace-from-still must composite the render over the clip through the person mask");
  node(graph, ARTIFACT, "SaveVideo");
  if (Object.values(graph).filter(entry => entry.class_type === "SaveVideo").length !== 1) throw new Error("Replace-from-still must write exactly one video");
}

/** Bind the reviewed graph to one clean clip, one approved still and one window length. */
export function compileFromStill(bundle: CapabilityBundle, invocation: Invocation, options: { frames?: number } = {}): ApiGraph {
  const frames = fromStillWindowFrames(options.frames ?? FROM_STILL_MAX_FRAMES);
  const graph = compileLocal(bundle, invocation);
  checkWiring(graph);
  setWindowFrames(graph, frames);
  const scene = typeof invocation.controls.prompt === "string" ? invocation.controls.prompt : "";
  const motion = typeof invocation.controls.pose_prompt === "string" ? invocation.controls.pose_prompt : "";
  graph[SCENE].inputs.value = fromStillScene(scene);
  graph[MOTION].inputs.value = fromStillMotion(motion);
  assertLocalGraphPolicy(graph);
  return graph;
}

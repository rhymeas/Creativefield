import type {ApiGraph} from "../workflow/build";
import {compileLocal} from "./compile";
import {assertLocalGraphPolicy} from "./policy";
import type {CapabilityBundle, Invocation} from "./types";

/* The anchor still is the frame the clip starts with, edited once: each person is replaced by the
   picture uploaded for them, and the frame's pose, position, scale, light and background stay.
   The reviewed template reads the frame from the clip (or from a prepared still), then feeds the
   frame and the pictures to Fibo 2.0 as three reference images in that order. The server has
   no contract for "one of two source inputs" or for dropping a second person, so this module
   rewires the compiled graph: exactly one source feeds the chosen frame, and a run with one
   picture leaves the second picture's branch out instead of loading a file that is not there. */

const VIDEO="1", VIDEO_FRAMES="2", FRAME="3", STILL="4";
const SECOND_CHARACTER="6";
/** The Fibo 2.0 encoder reads the frame, the first picture and the second picture on these sockets. */
const SECOND_SOCKET="images.image_3";
const PROMPT="11";

/** What the still asks for when the pictures are the only description of the new people. The
 *  frame is the edit target, so the words pin the scene and let the eyes and clothes change. */
export function anchorStillPrompt(twoPeople: boolean, extra = ""): string {
  const base = twoPeople
    ? "Keep the exact pose, position, size and light of both people. Change only their faces, hair and clothes. The person on the left becomes the person in the second picture. The person on the right becomes the person in the third picture. Copy the whole outfit and every accessory from each picture. Keep the background exactly as it is."
    : "Keep the exact pose, position, size and light of the person. Change only the face, hair and clothes. The person becomes the person in the second picture. Copy the whole outfit and every accessory. Keep the background exactly as it is.";
  const note = extra.trim();
  return note ? `${base}\n\n${note}` : base;
}

/** The compiled anchor still, with the one source that was chosen and the people that exist. */
export function compileAnchorStill(bundle: CapabilityBundle, invocation: Invocation): ApiGraph {
  const still = invocation.inputs.source_image;
  const clip = invocation.inputs.source_video;
  if (!still && !clip) throw new Error("Choose a clip or a still frame");
  const frame = invocation.controls.frame;
  if (still && typeof frame === "number" && frame !== 0) throw new Error("A still frame has only frame 0");
  const twoPeople = Boolean(invocation.inputs.character_image_2);
  /* compileLocal binds both source ports when both are given, and checks the frame control against
     its own node. It runs first so every binding, range and policy rule is checked once, then the
     unused branch is removed and the prompt is written. */
  const graph = compileLocal(bundle, invocation);
  if (still) {
    if (!graph[STILL] || graph[STILL].class_type !== "LoadImage") throw new Error("The anchor still has no still input");
    graph[FRAME].inputs.image = [STILL, 0];
    delete graph[VIDEO];
    delete graph[VIDEO_FRAMES];
  } else {
    delete graph[STILL];
  }
  if (!twoPeople) {
    delete graph[SECOND_CHARACTER];
    delete graph[PROMPT].inputs[SECOND_SOCKET];
  }
  const words = typeof invocation.controls.prompt === "string" ? invocation.controls.prompt : "";
  graph[PROMPT].inputs.prompt = anchorStillPrompt(twoPeople, words);
  assertLocalGraphPolicy(graph);
  return graph;
}

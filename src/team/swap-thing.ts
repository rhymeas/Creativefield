/* Swap a thing: the user names what to change; SAM 3.1 finds it in every frame (a mask nobody has to draw or
   upload), the mask is reviewed, and VACE edits only that area. Pure step builder, so the chain is testable. */
import type { ReplaceStep } from "./reference-replace";
import { capability } from "../capabilities/lookup";

export const MASK_CAPABILITY = capability("sam31-video-mask");
export const EDIT_CAPABILITY = capability("wan21-vace-masked-edit");
export const EDIT_REFERENCE_CAPABILITY = capability("wan21-vace-masked-edit-reference");

export type SwapThingInput = { video: string; target: string; reference?: string; prompt?: string };
export type SwapStep = ReplaceStep & {
  /** SAM 3.1 takes the object phrase as tracking input; its `prompt` control belongs to the server. */
  tracking?: { prompt: string };
  /** Nothing sets this while nobody has looked at the mask yet. */
  approveOutput?: boolean;
};

/** The clip the tracker can open, said under the video input. */
export const CLIP_ENVELOPE = "1 to 5 seconds, 16 fps, at most 832 px";
/** The same facts as a sentence, for when the server refuses a clip. */
export const CLIP_PROBLEM = "Use a clip of 1 to 5 seconds at 16 fps, at most 832 px a side.";
/** The tracker checks the clip itself and answers 422 in ffprobe words. */
const clipWords = /16 FPS|frames|pixels|video stream|rotation|MiB|damaged media|media is invalid/i;

/** Why the chain cannot be built yet, in the words shown under the button.
 *  The server wants at least two letters for the object phrase. */
export function swapThingProblem(input: Partial<SwapThingInput>): string | undefined {
  if (!input.video) return "Add your video.";
  if ((input.target?.trim().length ?? 0) < 2) return "Say what to change.";
  if (!input.reference && !input.prompt?.trim()) return "Add a picture or say what it becomes.";
  return undefined;
}

/** The mask step is the one that opens the clip, so a 422 there is about the clip: say the envelope in plain
 *  words instead of passing on ffprobe wording. Other problems keep the server's own sentence. */
export function swapClipProblem(stepId: string, error: unknown): string | undefined {
  if (stepId !== "mask" || (error as { status?: number } | null)?.status !== 422) return undefined;
  return clipWords.test((error as Error | null)?.message ?? "") ? CLIP_PROBLEM : undefined;
}

/** Said with every change, so the new thing takes the scene's light, shadows, size and angle and looks like it was always there. */
const BELONGS = "It matches the light, shadows, scale and perspective of the scene and looks like it was always there.";

/** Change only the area a mask selects. Before the mask is reviewed it points at the mask step's output;
 *  after review it names the approved mask asset, so the change can be queued on its own. */
export function swapEditStep(input: SwapThingInput, mask?: string): SwapStep {
  const target = input.target.trim(), prompt = input.prompt?.trim();
  // People type "the red car" or "red car"; the sentence reads well either way.
  const thing = target.replace(/^(the|a|an)\s+/i, "");
  const words = `${prompt ? prompt.replace(/[.!?]*$/, ".") : `The ${thing} becomes the object in the picture.`} ${BELONGS}`;
  const edit = input.reference ? EDIT_REFERENCE_CAPABILITY : EDIT_CAPABILITY;
  return { id: "edit", label: `Change ${target}`, capabilityId: edit.id, version: edit.version,
    inputs: { source_video: { asset: input.video }, edit_mask: mask ? { asset: mask } : { step: "mask" }, ...(input.reference ? { object_reference: { asset: input.reference } } : {}) },
    controls: { prompt: words } };
}

export function buildSwapSteps(input: SwapThingInput): SwapStep[] {
  const target = input.target.trim();
  return [
    { id: "mask", label: `Find ${target}`, capabilityId: MASK_CAPABILITY.id, version: MASK_CAPABILITY.version,
      inputs: { source_video: { asset: input.video } }, controls: {}, tracking: { prompt: target } },
    swapEditStep(input),
  ];
}

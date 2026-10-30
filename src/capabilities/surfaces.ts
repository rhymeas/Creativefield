import type { CapabilityManifestV2 } from "./types";

/** The part of the product a workflow belongs to. */
export type CapabilitySurface =
  | "image"
  | "video-create"
  | "video-edit"
  | "video-enhance"
  | "video-effect"
  | "motion"
  | "audio"
  | "replacement"
  | "identity"
  | "studios"
  | "canvas"
  | "other";

const videoOutput = (manifest: CapabilityManifestV2) => manifest.outputs.some(output => output.type === "video");
const imageOutput = (manifest: CapabilityManifestV2) => manifest.outputs.some(output => output.type === "image");
const audioOutput = (manifest: CapabilityManifestV2) => manifest.outputs.some(output => output.type === "audio");

/**
 * Classifies a workflow by what it does for the user, not by the folder it
 * happens to live in. Menus and pickers use this so image workflows never
 * appear in the video chooser and video workflows stay out of the image
 * chooser.
 */
export function capabilitySurface(manifest: CapabilityManifestV2): CapabilitySurface {
  if (manifest.category === "motion") return "motion";
  if (manifest.imageInputContract?.kind === "aligned_still_image_mask_v1") return "canvas";
  if (manifest.mediaContract?.kind === "aligned_video_mask_v1") return "video-edit";
  if (videoOutput(manifest)) {
    if (manifest.category === "enhance") return "video-enhance";
    if (manifest.category === "finishing") return "video-effect";
    return "video-create";
  }
  if (imageOutput(manifest) && !videoOutput(manifest)) return "image";
  if (audioOutput(manifest) || manifest.category === "audio") return "audio";
  if (manifest.category === "enhance") return "video-enhance";
  if (manifest.category === "finishing") return "video-effect";
  if (["t2v", "i2v", "flf2v", "video"].includes(manifest.category)) return "video-create";
  if (manifest.category === "replacement") return "replacement";
  if (manifest.category === "identity") return "identity";
  if (manifest.category === "studios") return "studios";
  if (manifest.category === "canvas") return "canvas";
  return "other";
}

export const surfaceOrder: CapabilitySurface[] = [
  "image", "video-create", "video-edit", "video-enhance", "video-effect", "motion",
  "audio", "replacement", "identity", "studios", "canvas", "other"
];

const labels: Record<CapabilitySurface, string> = {
  image: "Image generation",
  "video-create": "Video generation",
  "video-edit": "Video editing",
  "video-enhance": "Video enhancement",
  "video-effect": "Video effects",
  motion: "Motion control",
  audio: "Audio",
  replacement: "Replacement",
  identity: "Identity",
  studios: "Studios",
  canvas: "Canvas",
  other: "Other workflows"
};

export const surfaceLabel = (surface: CapabilitySurface) => labels[surface];

const purposes: Record<CapabilitySurface, string> = {
  image: "Turns your prompt or reference images into a still image.",
  "video-create": "Turns a prompt, a start image or two end frames into a new video.",
  "video-edit": "Changes only the masked area of a video and keeps the rest.",
  "video-enhance": "Makes an existing video sharper or larger.",
  "video-effect": "Restyles an existing video with a guided effect.",
  motion: "Copies the movement of a driving video onto a character image.",
  audio: "Works with voice, music or the audio track of a video.",
  replacement: "Replaces a person, object or background while keeping the rest.",
  identity: "Reuses a character or product identity through reference images.",
  studios: "Runs a guided multi-step production flow.",
  canvas: "Arranges shots, layers and edits on a working canvas.",
  other: "A workflow that does not fit the main output types yet."
};

export const surfacePurpose = (surface: CapabilitySurface) => purposes[surface];

/** Short sentence shown in menus and catalogue rows instead of raw manifest text. */
export const capabilityPurpose = (manifest: CapabilityManifestV2) => {
  if (/interpolat/i.test(manifest.title)) return "Adds in-between frames so motion looks smoother.";
  if (/upscal|esrgan/i.test(manifest.title)) return "Makes an existing video or image sharper and larger.";
  if (/segment|mask/i.test(manifest.title) && capabilitySurface(manifest) === "image") return "Finds and isolates an object or region in an image.";
  return surfacePurpose(capabilitySurface(manifest));
};

export const isImageWorkflow = (manifest: CapabilityManifestV2) => capabilitySurface(manifest) === "image";

/** Video generation, editing, enhancement, effects and motion all produce video. */
export const isVideoWorkflow = (manifest: CapabilityManifestV2) => {
  const surface = capabilitySurface(manifest);
  return surface === "video-create" || surface === "video-edit" || surface === "video-enhance" || surface === "video-effect" || surface === "motion";
};

/** Workflows that belong in the normal Create Video picker. */
export const isCreateVideoWorkflow = (manifest: CapabilityManifestV2) => capabilitySurface(manifest) === "video-create" && !manifest.inputs.some(port=>port.type==="video"&&port.required);

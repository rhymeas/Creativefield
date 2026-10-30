import type { Manifest, InputBinding } from "./manifest";

export type ApiGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export type JobParams = {
  prompt: string;
  negative: string;
  /** Uploaded filename on the ComfyUI server (from /upload/image). Required when the provider has a start-image input. */
  startImage?: string;
  /** Uploaded filename of the last frame. Required when the provider has an end-image input. */
  endImage?: string;
  /** Uploaded filename of the driving video. Required when the provider has a motion-video input. */
  motionVideo?: string;
  /** Describes the movement in the driving video. Optional; the template's own text is kept when empty. */
  motionPrompt?: string;
  resolution: string;
  durationSec: number;
  seed: number;
};

/** Wan video models expect frame counts of 4n+1 (81 frames = ~5 s at 16 fps). */
export function secondsToWanFrames(seconds: number, fps: number): number {
  const raw = Math.round(seconds * fps);
  return 4 * Math.round((raw - 1) / 4) + 1;
}

function convert(binding: InputBinding, value: unknown, fps: number): unknown {
  if (binding.map === "seconds_to_wan_frames") {
    return secondsToWanFrames(Number(value), fps);
  }
  return value;
}

/**
 * Returns a new API-format graph with the UI values written into the bound fields.
 * The template is never mutated, so the same template can build many jobs.
 * Works for any pipeline: a provider without a `start_image` binding (text to video) simply has
 * nothing to write there.
 */
export function buildGraph(template: ApiGraph, manifest: Manifest, params: JobParams): ApiGraph {
  const res = manifest.limits.resolutions[params.resolution];
  if (!res) {
    throw new Error(`Unknown resolution "${params.resolution}"`);
  }
  // A provider that fixes its own length (motion control) has no duration to check.
  if (manifest.inputs.length && (params.durationSec < manifest.limits.minDurationSec || params.durationSec > manifest.limits.maxDurationSec)) {
    throw new Error(
      `Duration must be between ${manifest.limits.minDurationSec} and ${manifest.limits.maxDurationSec} s`,
    );
  }
  if (manifest.inputs.start_image && !params.startImage) {
    throw new Error("This model needs a start image");
  }
  if (manifest.inputs.end_image && !params.endImage) {
    throw new Error("This model needs an end image");
  }
  if (manifest.inputs.motion_video && !params.motionVideo) {
    throw new Error("This model needs a motion video");
  }

  const graph: ApiGraph = structuredClone(template);
  const values: Record<keyof Manifest["inputs"], unknown> = {
    prompt: params.prompt,
    negative: params.negative,
    start_image: params.startImage,
    end_image: params.endImage,
    motion_video: params.motionVideo,
    motion_prompt: params.motionPrompt,
    width: res.width,
    height: res.height,
    length: params.durationSec,
    seed: params.seed,
  };

  for (const [name, binding] of Object.entries(manifest.inputs) as Array<[keyof Manifest["inputs"], InputBinding]>) {
    if (binding.node === null) {
      throw new Error(`Manifest input "${name}" has no node ID`);
    }
    // An empty negative or motion prompt keeps the template's own text.
    if (name === "negative" && !params.negative.trim()) continue;
    if (name === "motion_prompt" && !params.motionPrompt?.trim()) continue;
    const node = graph[binding.node];
    if (!node) {
      throw new Error(`Template has no node ${binding.node} for input "${name}"`);
    }
    node.inputs[binding.field] = convert(binding, values[name], manifest.limits.fps);
  }

  return graph;
}

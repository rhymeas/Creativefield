// Recovers what a job was from the graph ComfyUI stored with it. ComfyUI keeps every job's
// graph, so active history can be rebuilt from the server after a reload, including jobs
// started before the studio existed. The separate run ledger retains provenance metadata.

import type { ApiGraph } from "../workflow/build";
import type { Manifest } from "../workflow/manifest";
import type { Provider } from "./registry";

export type RecoveredParams = {
  prompt: string;
  negative: string;
  /** File name in ComfyUI's input folder. Empty for text to video. */
  startImage: string;
  /** File name of the last frame. Empty unless the job was first-and-last-frame. */
  endImage?: string;
  /** File name of the driving video of a motion-control job. */
  motionVideo?: string;
  /** What the driving video's movement is, in words, for a motion-control job. */
  motionPrompt?: string;
  /** A key of the manifest's resolutions, e.g. "landscape". */
  aspect: string;
  durationSec: number;
  seed: number;
};

/**
 * The provider whose template this graph came from, or undefined for a graph the studio did
 * not make (another frontend's job). A graph matches when it has the same nodes, with the
 * same classes, as the provider's template.
 */
export function matchProvider(graph: ApiGraph, providers: Provider[]): Provider | undefined {
  return providers.find(({ template }) => {
    const ids = Object.keys(template);
    return (
      ids.length === Object.keys(graph).length &&
      ids.every((id) => graph[id]?.class_type === template[id].class_type)
    );
  });
}

function read(graph: ApiGraph, binding: { node: string | null; field: string } | undefined): unknown {
  return !binding || binding.node === null ? undefined : graph[binding.node]?.inputs[binding.field];
}

/** Reads the studio's parameters back out of a graph by following the manifest's bindings. */
export function readParams(graph: ApiGraph, manifest: Manifest): RecoveredParams {
  const { inputs, limits } = manifest;
  const width = Number(read(graph, inputs.width));
  const height = Number(read(graph, inputs.height));
  const aspect =
    Object.entries(limits.resolutions).find(([, r]) => r.width === width && r.height === height)?.[0] ??
    Object.keys(limits.resolutions)[0];
  // Without a length input the template fixes the length, so there is no duration to read back.
  const frames = Number(read(graph, inputs.length));
  const durationSec = !inputs.length
    ? 0
    : inputs.length.map === "seconds_to_wan_frames"
      ? Math.round(((frames - 1) / limits.fps) * 10) / 10
      : frames;

  return {
    prompt: String(read(graph, inputs.prompt) ?? ""),
    negative: String(read(graph, inputs.negative) ?? ""),
    // Text-to-video providers have no start image.
    startImage: String(read(graph, inputs.start_image) ?? ""),
    endImage: inputs.end_image ? String(read(graph, inputs.end_image) ?? "") : "",
    motionVideo: inputs.motion_video ? String(read(graph, inputs.motion_video) ?? "") : "",
    motionPrompt: inputs.motion_prompt ? String(read(graph, inputs.motion_prompt) ?? "") : "",
    aspect,
    durationSec,
    seed: Number(read(graph, inputs.seed) ?? 0),
  };
}

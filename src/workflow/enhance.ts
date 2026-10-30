// Building, matching, and reading back enhance jobs (upscaling a finished clip).

import type { ApiGraph } from "./build";
import type { EnhanceManifest } from "./manifest";

export type EnhanceParams = {
  /** File name of the clip in ComfyUI's input folder. */
  sourceVideo: string;
  /** Final enlargement as a multiplier of the source, for example 2. */
  factor: number;
};

/** Returns a new graph that upscales `sourceVideo` by `factor`. The template is not changed. */
export function buildEnhanceGraph(template: ApiGraph, manifest: EnhanceManifest, params: EnhanceParams): ApiGraph {
  if (!manifest.factors.includes(params.factor)) {
    throw new Error(`This enhancer offers ${manifest.factors.map((f) => `${f}x`).join(" and ")}, not ${params.factor}x`);
  }
  const { source_video, scale } = manifest.inputs;
  if (source_video.node === null || scale.node === null) throw new Error("The enhancer manifest has an unset node ID");

  const graph: ApiGraph = structuredClone(template);
  if (!graph[source_video.node] || !graph[scale.node]) throw new Error("The enhancer template is missing a bound node");
  graph[source_video.node].inputs[source_video.field] = params.sourceVideo;
  // The model enlarges by nativeScale on its own; the scale node brings that down to the factor asked for.
  graph[scale.node].inputs[scale.field] = params.factor / manifest.nativeScale;
  return graph;
}

/** The enhancer whose template this graph came from: the same nodes with the same classes. */
export function matchEnhancer<T extends { template: ApiGraph }>(graph: ApiGraph, enhancers: T[]): T | undefined {
  return enhancers.find(({ template }) => {
    const ids = Object.keys(template);
    return ids.length === Object.keys(graph).length && ids.every((id) => graph[id]?.class_type === template[id].class_type);
  });
}

/** Reads the clip and factor back out of a stored graph. */
export function readEnhanceParams(graph: ApiGraph, manifest: EnhanceManifest): EnhanceParams {
  const { source_video, scale } = manifest.inputs;
  const file = source_video.node === null ? undefined : graph[source_video.node]?.inputs[source_video.field];
  const by = scale.node === null ? undefined : graph[scale.node]?.inputs[scale.field];
  return { sourceVideo: String(file ?? ""), factor: Math.round(Number(by ?? 1) * manifest.nativeScale * 100) / 100 };
}

/** Whether a source of this size can be enlarged by `factor` and still be encoded. */
export function factorFits(manifest: EnhanceManifest, source: { width: number; height: number }, factor: number): boolean {
  return Math.max(source.width, source.height) * factor <= manifest.maxOutputEdge;
}

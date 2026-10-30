/* What a running job is doing, named from the node the worker reports progress for. The worker sends
   progress for one node at a time and gives only its id; the run's stored graph says which class that
   node is, and the class says which part of the job is running. No database and no UI here, so the
   mapping is testable on its own. */
export type DevelopStage = "preparing" | "thinking" | "working" | "rendering" | "upscaling";

/** The stage a node class belongs to. The first rule that matches wins, so a model loader that also
 *  upscales still reads as getting ready. */
const STAGE_RULES: ReadonlyArray<readonly [DevelopStage, RegExp]> = [
  // Fetching a model or a file: nothing is made yet.
  ["preparing", /^Load|Loader|^Primitive|^Model|^Conditioning/],
  // Sharpening the result.
  ["upscaling", /upscal/i],
  // Writing the result out: decode the frames, combine, stitch, save.
  ["rendering", /^Save|^Preview|Decode|Combine|Stitch|^CreateVideo/],
  // The sampler paints the frames.
  ["working", /Sampler|Scheduler|Guider|Sigma|Noise/],
  // Finding out what is in the picture or the clip: masks, people, poses, words.
  ["thinking", /SAM|Mask|Pose|CLIP|TextGenerate|Describe|Encode|Crop|Resize|Batch|Composite|Switch|Scale|Image|Video|SCAIL/],
];

/** The stage a node class belongs to, or undefined for a class this does not know: the caller then
 *  says nothing rather than guessing. */
export function developStage(classType: string | null | undefined): DevelopStage | undefined {
  if (!classType) return undefined;
  for (const [stage, pattern] of STAGE_RULES) if (pattern.test(classType)) return stage;
  return undefined;
}

/** The stage of the node the worker is reporting progress for, or undefined when the graph cannot name it. */
export function stageForNode(
  graph: Record<string, { class_type?: string }> | null | undefined,
  node: string | null | undefined,
): DevelopStage | undefined {
  if (!node) return undefined;
  return developStage(graph?.[node]?.class_type);
}

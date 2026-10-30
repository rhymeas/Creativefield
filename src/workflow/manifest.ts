// A manifest tells the UI which inputs of an API-format ComfyUI graph it controls.
// The UI never edits the graph structure; it only writes values into these fields.

export type InputBinding = {
  /** Node ID in the API-format template. null means "not set yet". */
  node: string | null;
  /** Input name on that node, e.g. "text", "image", "width". */
  field: string;
  /** Optional conversion from the UI value, applied before writing. */
  map?: "seconds_to_wan_frames";
};

/** How a provider executes after the Studio submits its ComfyUI graph. */
export type ExecutionDeclaration =
  | { route: "native-comfy" }
  | { route: "api-via-comfy"; service: string }
  | { route: "unknown" };

export type Manifest = {
  id: string;
  /** The model this provider runs. Providers of different pipelines that share a model share a family, so the studio can keep the user's model when the pipeline changes. */
  family: string;
  label: string;
  /** Text the UI shows for this provider. */
  display: { title: string; subtitle: string; short: string; resolution: string };
  /** Declared execution route. This describes the graph, not where the ComfyUI server is hosted. */
  execution?: ExecutionDeclaration;
  /** Declares a duration mapping that the compatibility adapter must verify against the graph. */
  timing?: { frameMapping: "wan_seconds_floor_4n1" };
  modes: Array<"image_to_video" | "text_to_video" | "first_last_frame" | "motion_control">;
  inputs: {
    prompt: InputBinding;
    negative: InputBinding;
    /** Absent for text-to-video providers. */
    start_image?: InputBinding;
    /** Present only for first-and-last-frame providers. */
    end_image?: InputBinding;
    /** Present only for motion-control providers: the video whose movement is copied. */
    motion_video?: InputBinding;
    /** Present only for motion-control providers: a second prompt that describes that movement. */
    motion_prompt?: InputBinding;
    width: InputBinding;
    height: InputBinding;
    /** Absent when the template fixes the length itself (motion control makes one 81-frame pass). */
    length?: InputBinding;
    seed: InputBinding;
  };
  outputs: { video: { node: string | null } };
  limits: {
    minDurationSec: number;
    maxDurationSec: number;
    fps: number;
    resolutions: Record<string, { width: number; height: number }>;
  };
  /** Model files the template loads, relative to ComfyUI/models. Checked against the server in a later phase. */
  requires?: { models: Array<{ folder: string; file: string }> };
};

export type ManifestProblem = { path: string; message: string };

/** Checks a manifest's shape and that every binding points at a node in the template. */
export function validateManifest(
  manifest: Manifest,
  template: Record<string, { class_type: string; inputs: Record<string, unknown> }>,
): ManifestProblem[] {
  const problems: ManifestProblem[] = [];

  for (const [name, binding] of Object.entries(manifest.inputs) as Array<[string, InputBinding]>) {
    if (binding.node === null) {
      problems.push({ path: `inputs.${name}`, message: "node ID is not set" });
      continue;
    }
    const node = template[binding.node];
    if (!node) {
      problems.push({ path: `inputs.${name}`, message: `node ${binding.node} is not in the template` });
    } else if (!(binding.field in node.inputs)) {
      problems.push({
        path: `inputs.${name}`,
        message: `node ${binding.node} (${node.class_type}) has no input "${binding.field}"`,
      });
    }
  }

  const videoNode = manifest.outputs.video.node;
  if (videoNode === null) {
    problems.push({ path: "outputs.video", message: "node ID is not set" });
  } else if (!template[videoNode]) {
    problems.push({ path: "outputs.video", message: `node ${videoNode} is not in the template` });
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Enhancers: pipelines that take a finished clip and return a better one. They are not
// generators, so they have their own manifest: no prompt, seed, or size, just a source video
// and how much to enlarge it.
// ---------------------------------------------------------------------------

export type EnhanceManifest = {
  id: string;
  /** Always "enhance". The registry uses it to tell enhancers from generation providers. */
  kind: "enhance";
  label: string;
  display: { title: string; subtitle: string; short: string };
  execution?: ExecutionDeclaration;
  inputs: {
    /** The loader node's file input. The studio uploads the clip into ComfyUI's input folder first. */
    source_video: InputBinding;
    /** The node that sets the final size. Receives `factor / nativeScale`. */
    scale: InputBinding;
  };
  outputs: { video: { node: string | null } };
  /** How much the model enlarges on its own (RealESRGAN x4plus is 4). */
  nativeScale: number;
  /** Final enlargements the user can pick, as multipliers of the source. */
  factors: number[];
  /** The largest width or height the encoder can write. A factor that would exceed it is not offered. */
  maxOutputEdge: number;
  requires?: { models: Array<{ folder: string; file: string }> };
};

/** Checks that an enhancer manifest's bindings point at real nodes and fields. */
export function validateEnhanceManifest(
  manifest: EnhanceManifest,
  template: Record<string, { class_type: string; inputs: Record<string, unknown> }>,
): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  for (const [name, binding] of Object.entries(manifest.inputs) as Array<[string, InputBinding]>) {
    if (binding.node === null) {
      problems.push({ path: `inputs.${name}`, message: "node ID is not set" });
      continue;
    }
    const node = template[binding.node];
    if (!node) problems.push({ path: `inputs.${name}`, message: `node ${binding.node} is not in the template` });
    else if (!(binding.field in node.inputs)) {
      problems.push({ path: `inputs.${name}`, message: `node ${binding.node} (${node.class_type}) has no input "${binding.field}"` });
    }
  }
  const out = manifest.outputs.video.node;
  if (out === null) problems.push({ path: "outputs.video", message: "node ID is not set" });
  else if (!template[out]) problems.push({ path: "outputs.video", message: `node ${out} is not in the template` });
  if (!manifest.factors.length) problems.push({ path: "factors", message: "no enlargement factors are listed" });
  return problems;
}

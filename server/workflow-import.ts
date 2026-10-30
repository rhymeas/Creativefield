import type { ApiGraph } from "../src/workflow/build";
import type { ObjectInfo, UiWorkflow } from "../src/workflow/ui-to-api";
import { uiToApi } from "../src/workflow/ui-to-api";
import type { CapabilityManifestV2, Control, Port, Requirement } from "../src/capabilities/types";
import { assertLocalGraphPolicy } from "../src/capabilities/policy";
import { validateCapability } from "../src/capabilities/validate";

const IMAGE_OUTPUTS = new Set(["SaveImage", "SaveImageAdvanced"]);
const VIDEO_OUTPUTS = new Set(["SaveVideo"]);
/** Media loaders a person fills in: the graph field that holds the file, and the kind of input it is. */
const LOADERS = new Map<string, { media: "image" | "video" | "audio"; field: string }>([
  ["LoadImage", { media: "image", field: "image" }],
  ["LoadVideo", { media: "video", field: "file" }],
  ["LoadAudio", { media: "audio", field: "audio" }],
]);
const SOURCE_ID = { image: "image", video: "source_video", audio: "source_audio" } as const;
const PROMPT_FIELDS = ["prompt", "text", "positive", "positive_prompt"] as const;
const NEGATIVE_FIELDS = ["negative", "negative_prompt", "text_negative"] as const;

type GraphNode = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } };

export type WorkflowMapping = {
  source: { name: string; nodes: number; outputs: number };
  inputs: Array<{ port: string; node: string; nodeType: string; field: string }>;
  controls: Array<{ control: string; node: string; nodeType: string; field: string }>;
  outputs: Array<{ port: string; node: string; nodeType: string; media: "image" | "video" }>;
  dependencies: Array<{ kind: "node" | "model"; name: string; location?: string }>;
  /** Values used by several nodes (for example both samplers of a Wan 2.2 high/low split) stay at the template value. */
  fixed?: Array<{ control: string; nodes: string[]; reason: string }>;
};

export type WorkflowImportPreview = {
  manifest: CapabilityManifestV2;
  graph: ApiGraph;
  mapping: WorkflowMapping;
};

export class WorkflowImportError extends Error {
  constructor(readonly errors: Array<{ node?: string; class?: string; reason: string }>) {
    super(errors.map((error) => [error.node, error.class, error.reason].filter(Boolean).join(": ")).join("\n"));
    this.name = "WorkflowImportError";
  }
}

function slug(value: string): string {
  const text = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 64).replace(/^-+|-+$/g, "");
  return text || "imported-workflow";
}

function fieldValue(graph: ApiGraph, node: string, field: string): unknown {
  return graph[node]?.inputs?.[field];
}

function typeOf(value: unknown): Control["type"] {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return "string";
}

function bounds(field: string, value: unknown): Pick<Control, "min" | "max" | "step"> {
  if (typeof value !== "number") return {};
  if (field === "steps") return { min: 1, max: 200, step: 1 };
  if (field === "cfg") return { min: 0, max: 30, step: 0.1 };
  if (field === "seed" || field === "noise_seed") return { min: 0, max: 9007199254740991, step: 1 };
  if (field === "batch_size" || field === "batch") return { min: 1, max: 8, step: 1 };
  if (field === "width" || field === "height") return { min: 64, max: 4096, step: 8 };
  if (field === "length" || field === "frame_count") return { min: 1, max: 81, step: 1 };
  if (field === "duration") return { min: 1, max: 5, step: 1 };
  return {};
}

/** The number node holding a clip's seconds when the frame count is a math node over seconds and fps
    (floor(seconds * fps + 1) in the official Wan templates): the one feeding that math but no `fps` input. */
export function findSecondsNode(graph: ApiGraph): string | undefined {
  const fpsSources = new Set<string>();
  for (const consumer of Object.values(graph)) {
    const link = consumer.inputs?.fps;
    if (Array.isArray(link) && typeof link[0] === "string") fpsSources.add(link[0]);
  }
  for (const owner of Object.values(graph)) {
    const lengthLink = owner.inputs?.length ?? owner.inputs?.frame_count;
    const math = Array.isArray(lengthLink) && typeof lengthLink[0] === "string" ? graph[lengthLink[0]] : undefined;
    if (math?.class_type !== "ComfyMathExpression") continue;
    const seconds = Object.entries(math.inputs)
      .filter(([key, link]) => key.startsWith("values.") && Array.isArray(link) && typeof link[0] === "string")
      .map(([, link]) => (link as [string, number])[0])
      .filter((source) => !fpsSources.has(source) && ["PrimitiveFloat", "PrimitiveInt"].includes(graph[source]?.class_type) && typeof graph[source].inputs.value === "number");
    return seconds.length === 1 ? seconds[0] : undefined;
  }
  return undefined;
}

/** A bounded, explicit import. Unknown patterns fail; nothing is guessed silently. */
export function previewWorkflowImport(input: {
  name: string;
  label?: string;
  ui: UiWorkflow;
  objectInfo: ObjectInfo;
}): WorkflowImportPreview {
  const errors: Array<{ node?: string; class?: string; reason: string }> = [];
  const subgraphIds = new Set((input.ui.definitions?.subgraphs ?? []).map((subgraph) => subgraph.id));
  for (const node of input.ui.nodes) {
    if (!(node.type in input.objectInfo) && !subgraphIds.has(node.type) && !["MarkdownNote", "Note"].includes(node.type)) {
      errors.push({ node: String(node.id), class: node.type, reason: "Node class is not installed on this worker" });
    }
  }
  if (errors.length) throw new WorkflowImportError(errors);

  let graph: ApiGraph;
  try {
    graph = uiToApi(input.ui, input.objectInfo) as ApiGraph;
  } catch (error) {
    throw new WorkflowImportError([{ reason: (error as Error).message }]);
  }

  try {
    assertLocalGraphPolicy(graph);
  } catch (error) {
    throw new WorkflowImportError([{ reason: (error as Error).message }]);
  }

  const outputs = Object.entries(graph)
    .filter(([, node]) => IMAGE_OUTPUTS.has(node.class_type) || VIDEO_OUTPUTS.has(node.class_type))
    .sort(([left], [right]) => left.localeCompare(right, "en", { numeric: true }));
  if (!outputs.length) {
    throw new WorkflowImportError([{ reason: "No supported SaveImage, SaveImageAdvanced or SaveVideo output was found" }]);
  }

  const outputPorts: Port[] = [];
  const mappingOutputs: WorkflowMapping["outputs"] = [];
  for (const [index, [node, value]] of outputs.entries()) {
    const media = VIDEO_OUTPUTS.has(value.class_type) ? "video" : "image";
    const id = index === 0 ? media : `${media}_${index + 1}`;
    // The first output is the result; further Save nodes (previews, side-by-side) are kept but never required.
    outputPorts.push({ id, label: (value as GraphNode)._meta?.title ?? (media === "video" ? "Video" : "Image"), type: media, required: index === 0 });
    mappingOutputs.push({ port: id, node, nodeType: value.class_type, media });
  }

  // Every loader becomes an input, so no run silently uses the template's sample file.
  const loaderNodes = Object.entries(graph)
    .filter(([, node]) => LOADERS.has(node.class_type))
    .sort(([left], [right]) => left.localeCompare(right, "en", { numeric: true }));
  const seen = { image: 0, video: 0, audio: 0 };
  const inputs: Port[] = loaderNodes.map(([node, value]) => {
    const { media, field } = LOADERS.get(value.class_type)!;
    const count = ++seen[media];
    return {
      id: count === 1 ? SOURCE_ID[media] : `${SOURCE_ID[media]}_${count}`,
      // A default node title ("LoadImage") says nothing to a person; number them instead.
      label: (() => {
        const title = (value as GraphNode)._meta?.title;
        if (title && title !== value.class_type) return title;
        const total = loaderNodes.filter(([, other]) => LOADERS.get(other.class_type)!.media === media).length;
        const word = media[0].toUpperCase() + media.slice(1);
        return total > 1 ? `${word} ${count}` : word;
      })(),
      type: media,
      required: true,
      binding: { node, field },
    };
  });

  const controls: Control[] = [];
  const mappingControls: WorkflowMapping["controls"] = [];
  const fixed = new Map<string, { nodes: string[]; reason: string }>();
  // Only the first sampler adds noise in a split schedule, so its seed is the one that matters.
  const KEEP_FIRST = new Set(["seed"]);
  const addControl = (id: string, label: string, node: string, nodeType: string, field: string, value: unknown) => {
    if (fixed.has(id)) { fixed.get(id)!.nodes.push(node); return; }
    const existing = controls.findIndex((control) => control.id === id);
    if (existing >= 0) {
      if (KEEP_FIRST.has(id)) return;
      /* Several prompt encoders (a character swap or lip-sync template often has one per stage): no single text is
         the prompt, so none is exposed and each keeps the template's wording. The graph still runs unchanged. */
      // One control cannot safely drive two nodes, so the value stays as the template set it.
      const first = mappingControls.findIndex((entry) => entry.control === id);
      fixed.set(id, { nodes: [controls[existing].binding!.node, node], reason: "Used by more than one node; kept at the template value" });
      controls.splice(existing, 1);
      if (first >= 0) mappingControls.splice(first, 1);
      return;
    }
    controls.push({
      id,
      label,
      type: typeOf(value),
      ...(value === undefined ? {} : { default: value as Control["default"] }),
      ...bounds(id === "duration" ? "duration" : field, value),
      binding: { node, field },
      ...(id === "prompt" || id === "negative_prompt" ? { meaning: "prompt_hint" } : {}),
    });
    mappingControls.push({ control: id, node, nodeType, field });
  };

  const promptRole = new Map<string, "positive" | "negative">();
  for (const consumer of Object.values(graph)) {
    for (const [key, link] of Object.entries(consumer.inputs ?? {})) {
      if ((key === "positive" || key === "negative") && Array.isArray(link) && typeof link[0] === "string" && !promptRole.has(link[0])) promptRole.set(link[0], key);
    }
  }
  for (const [node, value] of Object.entries(graph).sort(([left], [right]) => left.localeCompare(right, "en", { numeric: true }))) {
    for (const field of PROMPT_FIELDS) {
      if (typeof fieldValue(graph, node, field) !== "string") continue;
      if (promptRole.get(node) === "negative") addControl("negative_prompt", "Negative prompt", node, value.class_type, field, fieldValue(graph, node, field));
      else addControl("prompt", "Prompt", node, value.class_type, field, fieldValue(graph, node, field));
      break;
    }
    for (const field of NEGATIVE_FIELDS) {
      if (typeof fieldValue(graph, node, field) !== "string") continue;
      addControl("negative_prompt", "Negative prompt", node, value.class_type, field, fieldValue(graph, node, field));
      break;
    }
    for (const [field, id, label] of [
      ["seed", "seed", "Seed"], ["noise_seed", "seed", "Seed"],
      ["steps", "steps", "Steps"], ["cfg", "cfg", "CFG"],
      ["width", "width", "Width"], ["height", "height", "Height"],
      ["batch_size", "batch_size", "Batch size"], ["batch", "batch_size", "Batch size"],
      ["length", "length", "Frames"], ["frame_count", "length", "Frames"],
    ] as const) {
      if (!(field in value.inputs)) continue;
      const raw = fieldValue(graph, node, field);
      if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") continue;
      addControl(id, label, node, value.class_type, field, raw);
    }
  }
  /* Official video templates often set the frame count as floor(seconds * fps + 1) in a math node, so no
     literal "length" exists. The number node that feeds that math but no fps input is the clip's seconds. */
  if (!controls.some((control) => control.id === "length")) {
    const seconds = findSecondsNode(graph);
    if (seconds) addControl("duration", "Seconds", seconds, graph[seconds].class_type, "value", graph[seconds].inputs.value);
  }
  // A prompt is optional: many templates (character replace, lip sync, upscale) are driven by media, not text.
  if (errors.length) throw new WorkflowImportError(errors);

  const nodes = Array.from(new Set(Object.values(graph).map((node) => node.class_type))).sort();
  const requirements: Requirement[] = nodes.map((name, index) => ({
    id: `node-${index + 1}-${slug(name)}`,
    kind: "node",
    name,
    instructions: `Install the ComfyUI node class ${name} before running this revision.`,
  }));
  const modelFields = [
    ["unet_name", "diffusion_models"],
    ["ckpt_name", "checkpoints"],
    ["clip_name", "text_encoders"],
    ["vae_name", "vae"],
    ["lora_name", "loras"],
  ] as const;
  const seenModels = new Set<string>();
  for (const value of Object.values(graph)) {
    for (const [field, location] of modelFields) {
      const name = value.inputs[field];
      if (typeof name !== "string" || seenModels.has(`${location}/${name}`)) continue;
      seenModels.add(`${location}/${name}`);
      requirements.push({
        id: `model-${requirements.length + 1}-${slug(name)}`,
        kind: "model",
        name,
        location,
        instructions: `Install ${name} in the ComfyUI ${location} folder before running this revision.`,
      });
    }
  }

  const manifest: CapabilityManifestV2 = {
    schemaVersion: 2,
    id: `imported-${slug(input.label ?? input.name)}`,
    version: "0.1.0",
    title: input.label ?? input.name.replace(/\.json$/i, ""),
    category: outputPorts[0].type === "video" ? "video" : "image",
    description: `Imported from the saved ComfyUI workflow ${input.name}. The app preserves this exact revision; it does not follow later edits in ComfyUI.`,
    inputs,
    outputs: outputPorts,
    controls,
    presets: [],
    routes: [{
      id: "local",
      execution: "local_comfy",
      provider: "comfy-local",
      upstreamProviders: [],
      implementation: "implemented",
      requirements,
      evidence: [`Imported snapshot ${input.name}; output ${mappingOutputs.map((output) => output.nodeType).join(", ")}.`],
    }],
    coverage: { local: "implemented", hosted: "planned" },
    licenses: { software: "ComfyUI core; imported node classes keep their own licenses.", weights: [] },
    sources: [{ url: `comfyui://userdata/workflows/${encodeURIComponent(input.name)}`, observedAt: new Date().toISOString(), kind: "implementation" }],
    tickets: ["WF-IMPORT-01"],
    audioPolicies: ["mute"],
  };

  try {
    validateCapability({ manifest, template: graph });
  } catch (error) {
    errors.push({ reason: `Capability validation failed: ${(error as Error).message}` });
  }
  if (errors.length) throw new WorkflowImportError(errors);

  return {
    manifest,
    graph,
    mapping: {
      source: { name: input.name, nodes: Object.keys(graph).length, outputs: outputPorts.length },
      inputs: inputs.map((port) => ({ port: port.id, node: port.binding!.node, nodeType: graph[port.binding!.node].class_type, field: port.binding!.field })),
      controls: mappingControls,
      outputs: mappingOutputs,
      dependencies: requirements.map((requirement) => ({ kind: requirement.kind as "node" | "model", name: requirement.name, ...(requirement.location ? { location: requirement.location } : {}) })),
      ...(fixed.size ? { fixed: [...fixed].map(([control, entry]) => ({ control, nodes: entry.nodes, reason: entry.reason })) } : {}),
    },
  };
}

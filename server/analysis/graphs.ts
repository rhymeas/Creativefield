/*
 * The two API prompt graphs the geometry stage submits, built from the frozen
 * templates in ./generated (see ./blueprint-conversion.ts for how they are
 * generated and why the only change to the official blueprints is appending the
 * output-binding nodes).
 *
 * Both builders are pure: callers get a deep copy and can submit several prompts
 * up front; ComfyUI serialises the GPU work itself.
 */
import type {ApiGraph} from "../../src/workflow/build";
import {
  MOGE_APPENDED_GRAPH,
  MOGE_BLUEPRINT_SHA256,
  MOGE_CORE_GRAPH,
  SAM3_APPENDED_GRAPH,
  SAM3_BLUEPRINT_SHA256,
  SAM3_CORE_GRAPH,
} from "./generated/graph-templates";

export {MOGE_BLUEPRINT_SHA256, SAM3_BLUEPRINT_SHA256};

/** The blobs the graphs write; the runner downloads exactly these node outputs. */
export const MOGE_OUTPUT_NODE = "9000";
export const SAM3_OUTPUT_NODE = "9002";

function nodeKey(graph: ApiGraph, classType: string): string {
  const key = Object.keys(graph).find((candidate) => graph[candidate].class_type === classType);
  if (!key) throw new Error(`Graph has no ${classType} node`);
  return key;
}

const MOGE_MESH_NODE = nodeKey(MOGE_CORE_GRAPH, "MoGePointMapToMesh");
const MOGE_MODEL_NODE = nodeKey(MOGE_CORE_GRAPH, "LoadMoGeModel");
const MOGE_LOADER_NODE = nodeKey(MOGE_CORE_GRAPH, "LoadImage");
const SAM3_DETECT_NODE = nodeKey(SAM3_CORE_GRAPH, "SAM3_Detect");
const SAM3_CHECKPOINT_NODE = nodeKey(SAM3_CORE_GRAPH, "CheckpointLoaderSimple");
const SAM3_LOADER_NODE = nodeKey(SAM3_CORE_GRAPH, "LoadVideo");
const SAM3_TEXT_NODE = nodeKey(SAM3_CORE_GRAPH, "CLIPTextEncode");

/** Blueprint node ids, reported as evidence with the blueprint sha256. */
export const GRAPH_NODE_IDS = {
  moge: {
    loader: MOGE_LOADER_NODE,
    mesh: MOGE_MESH_NODE,
    model: MOGE_MODEL_NODE,
    saveGlb: MOGE_OUTPUT_NODE,
  },
  sam3: {
    loader: SAM3_LOADER_NODE,
    detect: SAM3_DETECT_NODE,
    checkpoint: SAM3_CHECKPOINT_NODE,
    text: SAM3_TEXT_NODE,
    maskToImage: "9001",
    saveImage: SAM3_OUTPUT_NODE,
  },
} as const;

export type MogeGraphParams = {
  /** File name inside the ComfyUI input directory (uploaded keyframe still). */
  imageFile: string;
  /** filename_prefix of the appended SaveGLB node. */
  savePrefix: string;
  modelName?: string;
  /** Carry the source image as the mesh base-color texture (default: true, the blueprint value). */
  texture?: boolean;
  /** MoGe inference detail level 0..9 (blueprint default 9). */
  resolutionLevel?: number;
};

export type MogePrompt = {graph: ApiGraph; outputNode: string; nodeIds: typeof GRAPH_NODE_IDS.moge};

/** One MoGe prompt: a keyframe still -> GLB mesh in the ComfyUI output directory. */
export function mogeGraph(params: MogeGraphParams): MogePrompt {
  const core = structuredClone(MOGE_CORE_GRAPH);
  const appended = structuredClone(MOGE_APPENDED_GRAPH);
  core[MOGE_LOADER_NODE].inputs.image = params.imageFile;
  if (params.modelName) core[MOGE_MODEL_NODE].inputs.model_name = params.modelName;
  if (params.texture !== undefined) core[MOGE_MESH_NODE].inputs.texture = params.texture;
  if (params.resolutionLevel !== undefined) core[nodeKey(core, "MoGeInference")].inputs.resolution_level = params.resolutionLevel;
  appended[MOGE_OUTPUT_NODE].inputs.filename_prefix = params.savePrefix;
  return {graph: {...core, ...appended}, outputNode: MOGE_OUTPUT_NODE, nodeIds: GRAPH_NODE_IDS.moge};
}

export type Sam3GraphParams = {
  /** File name inside the ComfyUI input directory (uploaded 640 px shot clip). */
  videoFile: string;
  /** filename_prefix of the appended SaveImage node. */
  savePrefix: string;
  /** Text prompt; SAM 3.1 accepts "person" or "person:N" for up to N detections. */
  prompt?: string;
  modelName?: string;
  threshold?: number;
  refineIterations?: number;
};

export type Sam3Prompt = {graph: ApiGraph; outputNode: string; nodeIds: typeof GRAPH_NODE_IDS.sam3};

/** One SAM 3.1 prompt: a 640 px shot clip -> one mask PNG per detected object and frame. */
export function sam3Graph(params: Sam3GraphParams): Sam3Prompt {
  const core = structuredClone(SAM3_CORE_GRAPH);
  const appended = structuredClone(SAM3_APPENDED_GRAPH);
  core[SAM3_LOADER_NODE].inputs.file = params.videoFile;
  if (params.modelName) core[SAM3_CHECKPOINT_NODE].inputs.ckpt_name = params.modelName;
  if (params.prompt !== undefined) core[SAM3_TEXT_NODE].inputs.text = params.prompt;
  if (params.threshold !== undefined) core[SAM3_DETECT_NODE].inputs.threshold = params.threshold;
  if (params.refineIterations !== undefined) core[SAM3_DETECT_NODE].inputs.refine_iterations = params.refineIterations;
  appended[SAM3_OUTPUT_NODE].inputs.filename_prefix = params.savePrefix;
  return {graph: {...core, ...appended}, outputNode: SAM3_OUTPUT_NODE, nodeIds: GRAPH_NODE_IDS.sam3};
}

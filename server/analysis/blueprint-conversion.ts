/*
 * Blueprint -> API graph conversion for the geometry stage.
 *
 * The official ComfyUI blueprints are UI workflows: one top-level subgraph
 * instance whose inputs are unwired, no output nodes, and one node type that has
 * since been replaced (ResizeImagesByLongerEdge -> ImageScaleToMaxDimension).
 * This module reproduces what the ComfyUI editor does when a person loads the
 * blueprint and runs it: it expands the subgraph with src/workflow/ui-to-api.ts,
 * mirrors the editor's own node replacement (comfy_extras/nodes_replacements.py),
 * completes the source input and widget proxies the way the editor would, and
 * appends the output-binding nodes the blueprint deliberately omits.
 *
 * The two checked-in blueprints in ./blueprints are byte-identical copies of the
 * official files; ./object-info.json is the live /object_info trimmed to the
 * classes the graphs use, so the conversion is reproducible without a server.
 * server/analysis/generated/graph-templates.ts is generated from this module;
 * test/analysis-blueprints.test.ts re-runs the conversion and proves the frozen
 * templates still equal it.
 */
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import type {ApiGraph} from "../../src/workflow/build";
import {uiToApi, type ObjectInfo, type UiNode, type UiSubgraph, type UiWorkflow} from "../../src/workflow/ui-to-api";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const BLUEPRINT_DIR = join(HERE, "blueprints");

export type BlueprintKind = "moge" | "sam3";

export const BLUEPRINT_FILES: Record<BlueprintKind, string> = {
  moge: "geometry-estimation-moge.json",
  sam3: "video-segmentation-sam3.json",
};

/** Node ids the generated graph uses for the nodes we add to a blueprint. */
export const ADDED_NODE_IDS = {
  mogeLoader: "1000",
  mogeLink: 1000,
  sam3Loader: "1001",
  sam3Link: 1001,
  saveGlb: "9000",
  maskToImage: "9001",
  saveMask: "9002",
} as const;

export function readBlueprint(kind: BlueprintKind): UiWorkflow {
  return JSON.parse(readFileSync(join(BLUEPRINT_DIR, BLUEPRINT_FILES[kind]), "utf8")) as UiWorkflow;
}

export function readObjectInfo(): ObjectInfo {
  return JSON.parse(readFileSync(join(HERE, "object-info.json"), "utf8")) as ObjectInfo;
}

/**
 * The ComfyUI editor replaces this blueprint node on load. Mirrors
 * comfy_extras/nodes_replacements.py register_replacements_longeredge().
 */
function applyNodeReplacements(workflow: UiWorkflow): UiWorkflow {
  const replace = (node: UiNode): UiNode => {
    if (node.type !== "ResizeImagesByLongerEdge") return node;
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    const inputs = (node.inputs ?? []).map((input) => (input.name === "images" ? {...input, name: "image"} : input));
    return {
      ...node,
      type: "ImageScaleToMaxDimension",
      inputs,
      // New schema order: image (linked), upscale_method, largest_size. The old
      // node had a single widget, longer_edge.
      widgets_values: ["lanczos", values[0] ?? 2048],
    };
  };
  return {
    ...workflow,
    nodes: workflow.nodes.map(replace),
    definitions: {subgraphs: (workflow.definitions?.subgraphs ?? []).map((sub) => ({...sub, nodes: sub.nodes.map(replace)}))},
  };
}

/** Find the blueprint's single subgraph instance (the node whose type is a subgraph id). */
function findInstance(workflow: UiWorkflow): {instance: UiNode; subgraph: UiSubgraph} {
  const subgraphs = new Map((workflow.definitions?.subgraphs ?? []).map((sub) => [sub.id, sub]));
  const instance = workflow.nodes.find((node) => subgraphs.has(node.type));
  if (!instance) throw new Error("Blueprint has no subgraph instance");
  return {instance, subgraph: subgraphs.get(instance.type)!};
}

/**
 * Complete a blueprint the way the editor does before running it: wire a source
 * loader into the instance's first input and fill the instance's proxied widget
 * values (the blueprint leaves both unset).
 */
function completeBlueprint(workflow: UiWorkflow, loader: UiNode, linkId: number, widgets: unknown[]): {workflow: UiWorkflow; instance: UiNode} {
  const replaced = applyNodeReplacements(workflow);
  const {instance} = findInstance(replaced);
  const source = instance.inputs?.[0];
  if (!source) throw new Error("Subgraph instance has no inputs");
  const wired: UiNode = {
    ...instance,
    inputs: [{...source, link: linkId}, ...(instance.inputs ?? []).slice(1)],
    widgets_values: widgets,
  };
  return {
    workflow: {
      ...replaced,
      // The loader must come first: ui-to-api's converter validates links against
      // nodes it has already collected, and the subgraph instance pulls from it.
      nodes: [loader, ...replaced.nodes.map((node) => (node === instance ? wired : node))],
      // The blueprints have no top-level links; the completion adds exactly one.
      links: [[linkId, loader.id, 0, instance.id, 0, (source as {type?: string}).type ?? "IMAGE"]],
    },
    instance,
  };
}

/** MoGe-2 metric single-image geometry (GPU pass A). */
export function mogeCompletion(params: {imageFile: string; modelName: string} = {
  imageFile: "analysis-keyframe.jpg",
  modelName: "moge_2_vitl_normal_fp16.safetensors",
}): UiWorkflow {
  const loader: UiNode = {id: Number(ADDED_NODE_IDS.mogeLoader), type: "LoadImage", title: "analysis keyframe", widgets_values: [params.imageFile, "image"]};
  const {workflow} = completeBlueprint(readBlueprint("moge"), loader, ADDED_NODE_IDS.mogeLink, [9, 4, 0, 1, 0.04, true, params.modelName, false]);
  return workflow;
}

/** SAM 3.1 person segmentation on a 640 px shot clip (GPU pass B). */
export function sam3Completion(params: {videoFile: string; prompt: string; modelName: string} = {
  videoFile: "analysis-shot.mp4",
  prompt: "person",
  modelName: "sam3.1_multiplex_fp16.safetensors",
}): UiWorkflow {
  const loader: UiNode = {id: Number(ADDED_NODE_IDS.sam3Loader), type: "LoadVideo", title: "analysis shot clip", widgets_values: [params.videoFile, "video"]};
  // Widget order follows the subgraph's widget-type inputs: text, positive_coords,
  // negative_coords, threshold, refine_iterations, individual_masks, ckpt_name.
  const {workflow} = completeBlueprint(readBlueprint("sam3"), loader, ADDED_NODE_IDS.sam3Link, [params.prompt, "", "", 0.5, 2, true, params.modelName]);
  return workflow;
}

function firstKey(graph: ApiGraph, classType: string): string {
  const key = Object.keys(graph).find((nodeKey) => graph[nodeKey].class_type === classType);
  if (!key) throw new Error(`Converted graph has no ${classType} node`);
  return key;
}

export type ConvertedGraph = {core: ApiGraph; appended: ApiGraph};

/** The output-binding nodes appended to the MoGe blueprint graph (the one deliberate deviation). */
function mogeOutputs(core: ApiGraph, filenamePrefix: string): ApiGraph {
  return {
    [ADDED_NODE_IDS.saveGlb]: {
      class_type: "SaveGLB",
      inputs: {mesh: [firstKey(core, "MoGePointMapToMesh"), 0], filename_prefix: filenamePrefix},
    },
  };
}

/** The output-binding nodes appended to the SAM3 blueprint graph (the one deliberate deviation). */
function sam3Outputs(core: ApiGraph, filenamePrefix: string): ApiGraph {
  const maskKey = firstKey(core, "SAM3_Detect");
  return {
    [ADDED_NODE_IDS.maskToImage]: {class_type: "MaskToImage", inputs: {mask: [maskKey, 0]}},
    [ADDED_NODE_IDS.saveMask]: {class_type: "SaveImage", inputs: {images: [ADDED_NODE_IDS.maskToImage, 0], filename_prefix: filenamePrefix}},
  };
}

export type GraphOptions = {
  /** LoadImage/LoadVideo file name inside the ComfyUI input directory. */
  sourceFile?: string;
  modelName?: string;
  prompt?: string;
  /** filename_prefix for the appended save node. */
  savePrefix?: string;
};

export function convertMoge(options: GraphOptions = {}): ConvertedGraph {
  const completion = mogeCompletion({
    imageFile: options.sourceFile ?? "analysis-keyframe.jpg",
    modelName: options.modelName ?? "moge_2_vitl_normal_fp16.safetensors",
  });
  const core = uiToApi(completion, readObjectInfo());
  return {core, appended: mogeOutputs(core, options.savePrefix ?? "analysis/moge")};
}

export function convertSam3(options: GraphOptions = {}): ConvertedGraph {
  const completion = sam3Completion({
    videoFile: options.sourceFile ?? "analysis-shot.mp4",
    prompt: options.prompt ?? "person",
    modelName: options.modelName ?? "sam3.1_multiplex_fp16.safetensors",
  });
  const core = uiToApi(completion, readObjectInfo());
  return {core, appended: sam3Outputs(core, options.savePrefix ?? "analysis/sam3")};
}

/** The generated templates frozen into ./generated/graph-templates.ts. */
export function generateTemplates(): {moge: ConvertedGraph; sam3: ConvertedGraph} {
  return {moge: convertMoge(), sam3: convertSam3()};
}


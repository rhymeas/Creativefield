import { describe, expect, it } from "vitest";
import { partitionOutputIssues, summariseIssues, validateGraph } from "../src/workflow/validate-graph";
import type { ApiGraph } from "../src/workflow/build";
import type { ObjectInfo } from "../src/workflow/ui-to-api";

const info: ObjectInfo = {
  Loader: { input: { required: { file: [["a.safetensors", "b.safetensors"]] } } },
  Sampler: { input: { required: { model: ["MODEL"], steps: ["INT", { min: 1, max: 100 }], seed: ["INT", { min: 0 }] } } },
  Save: { input: { required: { images: ["IMAGE"] } }, output_node: true },
};
const good: ApiGraph = {
  "1": { class_type: "Loader", inputs: { file: "a.safetensors" } },
  "2": { class_type: "Sampler", inputs: { model: ["1", 0], steps: 20, seed: 5 } },
  "3": { class_type: "Save", inputs: { images: ["2", 0] } },
};

describe("validateGraph", () => {
  it("distinguishes disconnected diagnostics without hiding reachable or uncertain problems", () => {
    const graph: ApiGraph = { ...good, "4": { class_type: "Sampler", inputs: {} } };
    const issues = validateGraph(graph, info);
    expect(partitionOutputIssues(graph, info, issues).disconnected.length).toBeGreaterThan(0);
    expect(partitionOutputIssues(graph, info, issues).active).toEqual([]);
    const linked: ApiGraph = { ...graph, "3": { class_type: "Save", inputs: { images: ["4", 0] } } };
    expect(partitionOutputIssues(linked, info, validateGraph(linked, info)).active.length).toBeGreaterThan(0);
    expect(partitionOutputIssues(graph, null, issues).active).toEqual(issues);
    expect(partitionOutputIssues({ ...graph, "5": { class_type: "Unknown", inputs: {} } }, info, issues).active).toEqual(issues);
  });
  it("accepts a graph the server would accept", () => {
    expect(validateGraph(good, info)).toEqual([]);
  });

  it("finds a link to a node that is not in the graph, with no server at all", () => {
    const graph: ApiGraph = { ...good, "3": { class_type: "Save", inputs: { images: ["9", 0] } } };
    expect(validateGraph(graph, null).map(i => i.kind)).toEqual(["bad_link"]);
  });

  it("tells a missing node pack from a missing model file", () => {
    const graph: ApiGraph = {
      ...good,
      "1": { class_type: "Loader", inputs: { file: "gone.safetensors" } },
      "4": { class_type: "PackNode", inputs: {} },
    };
    const summary = summariseIssues(validateGraph(graph, info));
    expect(summary.nodes).toEqual(["PackNode"]);
    expect(summary.options).toEqual(["Loader.file=gone.safetensors"]);
  });

  it("flags a required input that is empty and a number outside the node's limits", () => {
    const graph: ApiGraph = { ...good, "2": { class_type: "Sampler", inputs: { model: ["1", 0], steps: 500 } } };
    expect(validateGraph(graph, info).map(i => `${i.kind}:${i.input}`).sort()).toEqual(["missing_input:seed", "out_of_range:steps"]);
  });

  it("does not judge the values the studio fills in before a job", () => {
    const graph: ApiGraph = { ...good, "1": { class_type: "Loader", inputs: { file: "placeholder.png" } } };
    expect(validateGraph(graph, info)).toHaveLength(1);
    expect(validateGraph(graph, info, new Set(["1.file"]))).toEqual([]);
  });

  it("accepts numeric options advertised by ComfyUI while rejecting unavailable values", () => {
    const numeric = { ...info, Choice: { input: { required: { size: [[8, 16, 32]] } } } } as unknown as ObjectInfo;
    const graph: ApiGraph = { ...good, "4": { class_type: "Choice", inputs: { size: 32 } } };
    expect(validateGraph(graph, numeric)).toEqual([]);
    graph["4"].inputs.size = 33;
    expect(validateGraph(graph, numeric).map(issue => issue.kind)).toEqual(["bad_option"]);
  });

  it("validates optional inputs when a workflow sets them without requiring absent ones", () => {
    const optional: ObjectInfo = {
      ...info,
      CreateVideo: { input: { optional: {
        bit_depth: ["COMBO", { options: ["auto", 8, 10] }],
        quality: ["FLOAT", { min: 0, max: 1 }],
      } } },
    };
    const graph: ApiGraph = {
      ...good,
      "4": { class_type: "CreateVideo", inputs: { bit_depth: 12, quality: 2 } },
    };
    expect(validateGraph(graph, optional).map(issue => `${issue.kind}:${issue.input}`).sort()).toEqual([
      "bad_option:bit_depth",
      "out_of_range:quality",
    ]);
    graph["4"].inputs = {};
    expect(validateGraph(graph, optional)).toEqual([]);
  });

  it("reads a dynamic input group from its member keys", () => {
    const dynamic: ObjectInfo = { ...info, Batch: { input: { required: { images: ["COMFY_AUTOGROW_V3", { template: {} }] } } } };
    const withMember: ApiGraph = { ...good, "4": { class_type: "Batch", inputs: { "images.image0": ["1", 0] } } };
    const empty: ApiGraph = { ...good, "4": { class_type: "Batch", inputs: {} } };
    const combo: ObjectInfo = { ...info, Out: { input: { required: { format: ["COMFY_DYNAMICCOMBO_V3", {}] } } } };
    expect(validateGraph({ ...good, "5": { class_type: "Out", inputs: { format: "mp4" } } }, combo)).toEqual([]);
    expect(validateGraph(withMember, dynamic)).toEqual([]);
    expect(validateGraph(empty, dynamic).map(i => i.kind)).toEqual(["missing_input"]);
    const maybe: ObjectInfo = { ...info, Batch: { input: { required: { images: ["COMFY_AUTOGROW_V3", { template: { min: 0 } }] } } } };
    expect(validateGraph(empty, maybe)).toEqual([]);
  });

  it("reports a graph that produces nothing", () => {
    const graph: ApiGraph = { "1": good["1"], "2": good["2"] };
    expect(validateGraph(graph, info).map(i => i.kind)).toEqual(["no_output"]);
  });
});

import { describe, expect, it } from "vitest";
import { findSecondsNode, previewWorkflowImport, WorkflowImportError } from "../server/workflow-import";
import type { ApiGraph } from "../src/workflow/build";
import type { ObjectInfo, UiWorkflow } from "../src/workflow/ui-to-api";

describe("bounded workflow import", () => {
  it("rejects a node class that the worker does not have before conversion", () => {
    const ui: UiWorkflow = {
      nodes: [{ id: 1, type: "NotInstalledNode", widgets_values: [] }],
      links: [],
    };
    expect(() => previewWorkflowImport({ name: "fixture.json", ui, objectInfo: {} as ObjectInfo }))
      .toThrowError(WorkflowImportError);
    expect(() => previewWorkflowImport({ name: "fixture.json", ui, objectInfo: {} as ObjectInfo }))
      .toThrowError("Node class is not installed on this worker");
  });

  it("finds the clip seconds behind floor(seconds * fps + 1), and not the fps", () => {
    const graph = {
      "1": { class_type: "PrimitiveFloat", inputs: { value: 5 } },
      "2": { class_type: "PrimitiveFloat", inputs: { value: 16 } },
      "3": { class_type: "ComfyMathExpression", inputs: { expression: "floor (a * b + 1)", "values.a": ["1", 0], "values.b": ["2", 0] } },
      "4": { class_type: "WanImageToVideo", inputs: { length: ["3", 1] } },
      "5": { class_type: "CreateVideo", inputs: { fps: ["2", 0] } },
    } as unknown as ApiGraph;
    expect(findSecondsNode(graph)).toBe("1");
    expect(findSecondsNode({ ...graph, "5": { class_type: "CreateVideo", inputs: { fps: 16 } } } as unknown as ApiGraph)).toBeUndefined();
    expect(findSecondsNode({ "4": { class_type: "WanImageToVideo", inputs: { length: 81 } } } as unknown as ApiGraph)).toBeUndefined();
  });

  it("allows a subgraph instance only because its definition is present", () => {
    const ui: UiWorkflow = {
      nodes: [{ id: 1, type: "subgraph-id", widgets_values: [] }],
      links: [],
      definitions: { subgraphs: [{ id: "subgraph-id", inputs: [], outputs: [], nodes: [], links: [] }] },
    };
    let message = "";
    try { previewWorkflowImport({ name: "fixture.json", ui, objectInfo: {} as ObjectInfo }); }
    catch (error) { message = (error as Error).message; }
    expect(message).not.toContain("Node class is not installed");
  });

  it("keeps one input per media loader and further outputs optional", () => {
    const optional = (name: string, type: string) => ({ [name]: [type] });
    const info = {
      LoadImage: { output_node: false, input: { required: { image: [["a.png"]] } }, input_order: { required: ["image"] } },
      LoadVideo: { output_node: false, input: { required: { file: [["v.mp4"]] } }, input_order: { required: ["file"] } },
      LoadAudio: { output_node: false, input: { required: { audio: [["s.wav"]] } }, input_order: { required: ["audio"] } },
      CLIPTextEncode: { output_node: false, input: { required: { text: ["STRING"] } }, input_order: { required: ["text"] } },
      WanImageToVideo: { output_node: false, input: { required: { ...optional("a", "IMAGE"), ...optional("b", "IMAGE"), ...optional("c", "VIDEO"), ...optional("d", "AUDIO"), ...optional("e", "CONDITIONING") } }, input_order: { required: ["a", "b", "c", "d", "e"] } },
      SaveVideo: { output_node: true, input: { required: { video: ["VIDEO"] } }, input_order: { required: ["video"] } },
    } as unknown as ObjectInfo;
    const ui: UiWorkflow = {
      nodes: [
        { id: 1, type: "LoadImage", widgets_values: ["a.png", "image"] },
        { id: 2, type: "LoadImage", widgets_values: ["a.png", "image"] },
        { id: 3, type: "LoadVideo", widgets_values: ["v.mp4"] },
        { id: 4, type: "LoadAudio", widgets_values: ["s.wav"] },
        { id: 5, type: "CLIPTextEncode", widgets_values: ["a prompt"] },
        { id: 8, type: "WanImageToVideo", inputs: ["a", "b", "c", "d", "e"].map((name, i) => ({ name, link: i + 1 })) },
        { id: 6, type: "SaveVideo", inputs: [{ name: "video", link: 6 }] },
        { id: 7, type: "SaveVideo", inputs: [{ name: "video", link: 7 }] },
      ],
      links: [[1, 1, 0, 8, 0], [2, 2, 0, 8, 1], [3, 3, 0, 8, 2], [4, 4, 0, 8, 3], [5, 5, 0, 8, 4], [6, 8, 0, 6, 0], [7, 8, 0, 7, 0]] as never,
    };
    const preview = previewWorkflowImport({ name: "multi.json", ui, objectInfo: info });
    expect(preview.manifest.inputs.map((port) => `${port.id}:${port.type}`).sort())
      .toEqual(["image:image", "image_2:image", "source_audio:audio", "source_video:video"]);
    expect(preview.manifest.inputs.every((port) => port.required)).toBe(true);
    expect(preview.manifest.inputs.map((port) => port.label).sort()).toEqual(["Audio", "Image 1", "Image 2", "Video"]);
    expect(preview.manifest.outputs.map((port) => port.required)).toEqual([true, false]);
    expect(preview.mapping.inputs.find((entry) => entry.port === "source_video")).toMatchObject({ node: "3", field: "file" });
  });
});

import { describe, expect, it, vi } from "vitest";

// A Wan 2.2 style high/low-noise split, as the official templates convert it.
const graph = {
  "1": { class_type: "LoadImage", inputs: { image: "start.png" } },
  "2": { class_type: "CLIPTextEncode", inputs: { text: "a camera move", clip: ["9", 0] } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "blurry", clip: ["9", 0] } },
  "4": { class_type: "WanCameraImageToVideo", inputs: { positive: ["2", 0], negative: ["3", 0], start_image: ["1", 0], width: 640, height: 640, length: 81, batch_size: 1 } },
  "5": { class_type: "KSamplerAdvanced", inputs: { model: ["10", 0], positive: ["4", 0], negative: ["4", 1], latent_image: ["4", 2], noise_seed: 7, steps: 4, cfg: 1, add_noise: "enable" } },
  "6": { class_type: "KSamplerAdvanced", inputs: { model: ["11", 0], positive: ["4", 0], negative: ["4", 1], latent_image: ["5", 0], noise_seed: 0, steps: 4, cfg: 1, add_noise: "disable" } },
  "7": { class_type: "SaveVideo", inputs: { video: ["6", 0], filename_prefix: "video/x" } },
};
vi.mock("../src/workflow/ui-to-api", () => ({ uiToApi: () => structuredClone(graph) }));
const { previewWorkflowImport } = await import("../server/workflow-import");
const objectInfo = Object.fromEntries(Object.values(graph).map((node) => [node.class_type, { input: { required: {} } }]));

describe("importing a two-sampler split", () => {
  it("maps positive and negative prompts by wiring and keeps the first sampler's seed", () => {
    const ui = { nodes: Object.values(graph).map((node, i) => ({ id: i + 1, type: node.class_type, widgets_values: [] })), links: [] };
    const { mapping, manifest } = previewWorkflowImport({ name: "split.json", ui: ui as never, objectInfo: objectInfo as never });
    const byId = Object.fromEntries(mapping.controls.map((control) => [control.control, control.node]));
    expect(byId.prompt).toBe("2");
    expect(byId.negative_prompt).toBe("3");
    expect(byId.seed).toBe("5");
    expect(byId.steps).toBeUndefined();
    expect(byId.cfg).toBeUndefined();
    expect(mapping.fixed?.map((entry) => entry.control).sort()).toEqual(["cfg", "steps"]);
    expect(manifest.controls.some((control) => control.id === "steps")).toBe(false);
  });
});

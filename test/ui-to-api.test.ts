import { describe, expect, it } from "vitest";
import ui from "../pipelines/i2v/wan22-ti2v-5b/source.ui.json";
import info from "./fixtures/object_info.wan22.json";
import { uiToApi, type ObjectInfo, type UiWorkflow } from "../src/workflow/ui-to-api";

const workflow = ui as unknown as UiWorkflow;
const objectInfo = info as unknown as ObjectInfo;

describe("isolated template scratch nodes", () => {
  const schemas: ObjectInfo = {
    ImageFromBatch: {
      output_node: false,
      input: { required: { image: ["IMAGE"] } },
      input_order: { required: ["image"] },
    },
    SaveImage: {
      output_node: true,
      input: { required: { images: ["IMAGE"] } },
      input_order: { required: ["images"] },
    },
  };
  const scratch: UiWorkflow = { nodes: [{ id: 308, type: "ImageFromBatch" }], links: [] };

  it("omits an isolated known non-output inside a subgraph", () => {
    const nested: UiWorkflow = {
      nodes: [{ id: 306, type: "sub" }], links: [],
      definitions: { subgraphs: [{ id: "sub", inputs: [], outputs: [], nodes: scratch.nodes, links: [] }] },
    };
    expect(uiToApi(nested, schemas)).toEqual({});
    expect(uiToApi(scratch, schemas)).toEqual({});
  });

  it("still rejects a connected node with a missing required input", () => {
    const connected: UiWorkflow = {
      nodes: [...scratch.nodes, { id: 309, type: "SaveImage", inputs: [{ name: "images", link: 1 }] }],
      links: [[1, 308, 0, 309, 0, "IMAGE"]],
    };
    expect(() => uiToApi(connected, schemas)).toThrow(/308.*image.*not connected/);
  });

  it("preserves output validation and explicit scratch-node enables", () => {
    expect(() => uiToApi({ nodes: [{ id: 1, type: "SaveImage" }], links: [] }, schemas))
      .toThrow(/images.*not connected/);
    expect(() => uiToApi(scratch, schemas, { enable: [308] })).toThrow(/image.*not connected/);
  });

  it("does not hide unknown schemas or dangling input links", () => {
    expect(() => uiToApi(scratch, {})).toThrow(/not installed/);
    const dangling: UiWorkflow = { nodes: [{ ...scratch.nodes[0], inputs: [{ name: "image", link: 77 }] }], links: [] };
    expect(() => uiToApi(dangling, schemas)).toThrow(/link 77.*does not exist/);
    const unknownOutputFlag = structuredClone(schemas);
    delete unknownOutputFlag.ImageFromBatch.output_node;
    expect(() => uiToApi(scratch, unknownOutputFlag)).toThrow(/image.*not connected/);
  });
});

describe("uiToApi on the Wan 2.2 TI2V 5B template", () => {
  it("skips notes and the bypassed image loader by default", () => {
    const g = uiToApi(workflow, objectInfo);
    expect(g["59"]).toBeUndefined(); // MarkdownNote
    expect(g["56"]).toBeUndefined(); // LoadImage is bypassed in the template
    expect(Object.keys(g).sort()).toEqual(["3", "37", "38", "39", "48", "55", "57", "58", "6", "7", "8"]);
  });

  it("keeps the image loader when it is enabled, and wires it into the latent node", () => {
    const g = uiToApi(workflow, objectInfo, { enable: [56] });
    expect(g["56"].class_type).toBe("LoadImage");
    expect(g["56"].inputs.image).toBe("example.png"); // the upload-button slot is skipped, not read as a value
    expect(g["55"].inputs.start_image).toEqual(["56", 0]);
  });

  it("maps widget values by input order, including the seed control slot", () => {
    const g = uiToApi(workflow, objectInfo);
    expect(g["3"].inputs).toMatchObject({
      seed: 898471028164125,
      steps: 20,
      cfg: 5,
      sampler_name: "uni_pc",
      scheduler: "simple",
      denoise: 1,
    });
    expect(g["55"].inputs).toMatchObject({ width: 1280, height: 704, length: 121, batch_size: 1 });
    expect(g["57"].inputs.fps).toBe(24);
    expect(g["58"].inputs).toMatchObject({ filename_prefix: "video/ComfyUI", format: "auto", "format.codec": "auto" });
    expect(g["37"].inputs).toEqual({ unet_name: "wan2.2_ti2v_5B_fp16.safetensors", weight_dtype: "default" });
  });

  it("resolves links to [node id, output slot] pairs", () => {
    const g = uiToApi(workflow, objectInfo);
    expect(g["3"].inputs.model).toEqual(["48", 0]);
    expect(g["3"].inputs.positive).toEqual(["6", 0]);
    expect(g["3"].inputs.negative).toEqual(["7", 0]);
    expect(g["3"].inputs.latent_image).toEqual(["55", 0]);
    expect(g["8"].inputs).toEqual({ samples: ["3", 0], vae: ["39", 0] });
    expect(g["58"].inputs.video).toEqual(["57", 0]);
  });

  it("fails clearly when a node class is not installed", () => {
    const missing = { ...objectInfo };
    delete (missing as Record<string, unknown>).KSampler;
    expect(() => uiToApi(workflow, missing)).toThrow(/KSampler.*not installed/);
  });

  it("leaves an optional input unconnected when its source is bypassed", () => {
    // Node 55's start_image is optional and fed by the bypassed loader 56.
    const g = uiToApi(workflow, objectInfo);
    expect(g["55"].inputs).not.toHaveProperty("start_image");
  });

  it("fails clearly when a required input is fed by a bypassed node", () => {
    const broken = structuredClone(workflow);
    broken.nodes.find((n) => n.id === 55)!.mode = 4; // KSampler.latent_image needs node 55
    expect(() => uiToApi(broken, objectInfo)).toThrow(/latent_image.*bypassed/);
  });
});

// ---------------------------------------------------------------------------
// Subgraphs: the Wan 2.2 14B template keeps its whole pipeline inside one subgraph instance.
// ---------------------------------------------------------------------------
import ui14 from "../pipelines/i2v/wan22-i2v-14b/source.ui.json";
import info14 from "./fixtures/object_info.wan22-14b.json";

describe("uiToApi with a subgraph (Wan 2.2 14B template)", () => {
  const wf = ui14 as unknown as UiWorkflow;
  const infoMap = info14 as unknown as ObjectInfo;
  const g = uiToApi(wf, infoMap);

  it("flattens the instance into ordinary nodes keyed like the editor does", () => {
    expect(g["129"]).toBeUndefined(); // the instance itself is gone
    expect(g["129:98"].class_type).toBe("WanImageToVideo");
    expect(Object.keys(g)).toHaveLength(32);
    expect(Object.keys(g).filter((k) => !k.includes(":")).sort()).toEqual(["108", "97"]);
  });

  it("wires the subgraph's input and output through to the outer nodes", () => {
    expect(g["129:98"].inputs.start_image).toEqual(["97", 0]); // outer LoadImage feeds the subgraph input
    expect(g["108"].inputs.video).toEqual(["129:94", 0]); // the subgraph output feeds the outer SaveVideo
  });

  it("uses the instance's own widget values for subgraph inputs that nothing outside feeds", () => {
    const widgets = (wf.nodes.find((n) => n.type === "84e2cf3f-de93-40ef-ab22-b9375296917b")!.widgets_values as unknown[]);
    expect(g["129:93"].inputs.text).toBe(widgets[0]); // prompt
    expect(g["129:98"].inputs).toMatchObject({ width: 640, height: 640 });
    expect(g["129:161"].inputs.value).toBe(5); // duration in seconds
    expect(g["129:86"].inputs.noise_seed).toBe(264244520398999);
    expect(g["129:95"].inputs.unet_name).toBe("wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors");
  });

  it("keeps links between inner nodes and carries run-time inputs by name", () => {
    expect(g["129:85"].inputs.latent_image).toEqual(["129:86", 0]);
    expect(g["129:163"].inputs).toMatchObject({ expression: "floor (a * b + 1)", "values.a": ["129:161", 0], "values.b": ["129:162", 0] });
    expect(g["129:98"].inputs.length).toEqual(["129:163", 1]);
  });

  it("has the provider's turbo switch on, so the 4-step Lightning LoRAs run", () => {
    expect(g["129:131"].inputs.value).toBe(true);
  });

  it("lets an outside link win over the instance's widget value", () => {
    const small: UiWorkflow = {
      nodes: [
        { id: 1, type: "PrimitiveInt", widgets_values: [7, "fixed"] },
        { id: 2, type: "sub", inputs: [{ name: "value", link: 10 }], widgets_values: [99] },
      ],
      links: [[10, 1, 0, 2, 0, "INT"]],
      definitions: {
        subgraphs: [
          {
            id: "sub",
            inputs: [{ name: "value", type: "INT" }],
            outputs: [],
            nodes: [{ id: 5, type: "PrimitiveInt", inputs: [{ name: "value", link: 20 }], widgets_values: [0, "fixed"] }],
            links: [{ id: 20, origin_id: -10, origin_slot: 0, target_id: 5, target_slot: 0 }],
          },
        ],
      },
    };
    const out = uiToApi(small, infoMap);
    expect(out["2:5"].inputs.value).toEqual(["1", 0]); // fed by the outside node, not the widget value 99
  });

  it("uses the inner saved widget when a proxy has no instance value", () => {
    const proxy: UiWorkflow = {
      nodes: [{ id: 2, type: "sub", widgets_values: [] }], links: [],
      definitions: { subgraphs: [{
        id: "sub", inputs: [{ name: "value", type: "INT" }], outputs: [],
        nodes: [{ id: 5, type: "PrimitiveInt", inputs: [{ name: "value", link: 20 }], widgets_values: [42, "fixed"] }],
        links: [{ id: 20, origin_id: -10, origin_slot: 0, target_id: 5, target_slot: 0 }],
      }] },
    };
    expect(uiToApi(proxy, infoMap)["2:5"].inputs.value).toBe(42);
    proxy.definitions!.subgraphs![0].nodes[0].widgets_values = [];
    expect(() => uiToApi(proxy, infoMap)).toThrow(/value.*not connected/);
    proxy.nodes[0].widgets_values = [0];
    expect(uiToApi(proxy, infoMap)["2:5"].inputs.value).toBe(0);
  });
});

describe("Reroute nodes", () => {
  const schemas: ObjectInfo = {
    LoadImage: { output_node: false, input: { required: { image: [["a.png"]] } }, input_order: { required: ["image"] } },
    SaveImage: { output_node: true, input: { required: { images: ["IMAGE"] } }, input_order: { required: ["images"] } },
  };
  const wire = (ids: Array<[number, number]>) => ids;
  it("passes through a chain of reroutes: the input is whatever feeds them", () => {
    const ui: UiWorkflow = {
      nodes: [
        { id: 1, type: "LoadImage", widgets_values: ["a.png", "image"] },
        { id: 2, type: "Reroute", inputs: [{ name: "", link: 1 }] },
        { id: 3, type: "Reroute", inputs: [{ name: "", link: 2 }] },
        { id: 4, type: "SaveImage", inputs: [{ name: "images", link: 3 }], widgets_values: ["x"] },
      ],
      links: [[1, 1, 0, 2, 0], [2, 2, 0, 3, 0], [3, 3, 0, 4, 0]] as never,
    };
    void wire;
    const graph = uiToApi(ui, schemas);
    expect(Object.keys(graph).sort()).toEqual(["1", "4"]);
    expect(graph["4"].inputs.images).toEqual(["1", 0]);
  });
});

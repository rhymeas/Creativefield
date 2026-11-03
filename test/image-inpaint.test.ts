import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateImageArtifacts } from "../src/capabilities/image-artifacts";
import { assertLocalGraphPolicy } from "../src/capabilities/policy";
import { capabilityReadiness } from "../src/capabilities/readiness";
import type { CapabilityBundle, CapabilityManifestV2 } from "../src/capabilities/types";
import { validateCapability } from "../src/capabilities/validate";

const manifest = JSON.parse(readFileSync("native-workflows/image-edit-sd21-inpaint/manifest.json", "utf8")) as CapabilityManifestV2;
const template = JSON.parse(readFileSync("native-workflows/image-edit-sd21-inpaint/template.api.json", "utf8"));
const bundle: CapabilityBundle = { manifest, template };

function requirements() {
  const route = manifest.routes[0];
  return {
    nodes: route.requirements.filter(item => item.kind === "node").map(item => item.name),
    models: route.requirements.filter(item => item.kind === "model").map(item => `${item.location}/${item.name}`),
  };
}

describe("SD 2.1 inpaint image artifact contract", () => {
  it("validates independently of the existing video contracts", () => {
    expect(validateCapability(bundle)).toEqual([]);
    expect(manifest.imageArtifacts?.kind).toBe("image_artifacts_v1");
    expect(manifest.mediaContract).toBeUndefined();
    expect(manifest.outputContract).toBeUndefined();
    expect(() => assertLocalGraphPolicy(template)).not.toThrow();
  });

  it("binds separate source and mask inputs and the exact core graph", () => {
    expect(manifest.inputs.map(input => [input.id, input.binding])).toEqual([
      ["source_image", { node: "1", field: "image" }],
      ["edit_mask", { node: "2", field: "image" }],
    ]);
    expect(template["3"]).toMatchObject({ class_type: "ImageToMask", inputs: { image: ["2", 0], channel: "red" } });
    expect(template["7"]).toMatchObject({ class_type: "VAEEncodeForInpaint", inputs: { pixels: ["1", 0], mask: ["3", 0] } });
    expect(template["10"]).toMatchObject({ class_type: "ImageCompositeMasked", inputs: { destination: ["1", 0], source: ["9", 0], mask: ["3", 0] } });
    expect(template["11"]).toMatchObject({ class_type: "SaveImage", inputs: { images: ["10", 0] } });
    expect([...new Set(Object.values(template).map((node: any) => node.class_type))].sort()).toEqual([
      "CheckpointLoaderSimple", "CLIPTextEncode", "ImageCompositeMasked", "ImageToMask", "KSampler",
      "LoadImage", "SaveImage", "VAEDecode", "VAEEncodeForInpaint",
    ].sort());
  });

  it("pins checkpoint identity, size, source revision and declared license", () => {
    const checkpoint = manifest.routes[0].requirements.find(item => item.id === "model:sd21-inpaint");
    expect(checkpoint).toMatchObject({
      kind: "model",
      name: "512-inpainting-ema.safetensors",
      location: "checkpoints",
      version: "sha256:b29e2ed9a8fe58e76f7e801bda091d23738bd74c1da3f339bcbe2d40922fcb",
      bytes: 5214662094,
      sourceRevision: "ec5db49993ae0a935f32ff9f36c1cfbd5f94cca6",
    });
    expect(manifest.licenses.weights[0].license).toContain("CreativeML Open RAIL++-M");
  });

  it("is hidden from the menus: the route is experimental until it passes qualification again", () => {
    const { nodes, models } = requirements();
    const state = capabilityReadiness(manifest, "local", { online: true, nodes, models, credentials: [] });
    expect(state.state).toBe("unsupported");
    expect(state.reasons.join(" ")).toContain("Experimental");
  });

  it("declares deterministic output and parent order with bounded PNG policy", () => {
    const contract = manifest.imageArtifacts!;
    expect(contract.artifacts.map(item => item.id)).toEqual(["edited-image"]);
    expect(contract.artifacts[0]).toMatchObject({
      outputPort: "edited_image",
      node: "11",
      nodeOutput: 0,
      role: "image",
      contentType: "image/png",
      cardinality: { min: 1, max: 1 },
      indexing: { strategy: "history_array", start: 0 },
      alpha: "allow",
      parents: [
        { order: 0, inputPort: "source_image", role: "source" },
        { order: 1, inputPort: "edit_mask", role: "mask" },
      ],
    });
  });

  it("rejects duplicate, unsafe and mismatched artifact declarations", () => {
    const duplicate = structuredClone(manifest.imageArtifacts!);
    duplicate.maxArtifacts = 2;
    duplicate.artifacts.push(structuredClone(duplicate.artifacts[0]));
    expect(validateImageArtifacts(duplicate, manifest, template).join(" ")).toMatch(/duplicate/i);

    const unsafe = structuredClone(manifest.imageArtifacts!);
    unsafe.artifacts[0].node = "../11";
    unsafe.artifacts[0].outputPort = "../edited_image";
    expect(validateImageArtifacts(unsafe, manifest, template).join(" ")).toMatch(/invalid/i);

    const missingId = structuredClone(manifest.imageArtifacts!);
    delete (missingId.artifacts[0] as Partial<(typeof missingId.artifacts)[number]>).id;
    expect(validateImageArtifacts(missingId, manifest, template).join(" ")).toContain("artifact id");

    const wrongRole = structuredClone(manifest.imageArtifacts!);
    (wrongRole.artifacts[0] as { role: string }).role = "video";
    expect(validateImageArtifacts(wrongRole, { ...manifest, outputs: [{ ...manifest.outputs[0], type: "video" }] }, template).join(" ")).toContain("output port");

    const parentOrder = structuredClone(manifest.imageArtifacts!);
    parentOrder.artifacts[0].parents[1].order = 4;
    expect(validateImageArtifacts(parentOrder, manifest, template).join(" ")).toContain("parent order");

    const parentRole = structuredClone(manifest.imageArtifacts!);
    parentRole.artifacts[0].parents[0].role = "unknown" as never;
    expect(validateImageArtifacts(parentRole, manifest, template).join(" ")).toContain("parent role");

    const wrongNode = structuredClone(manifest.imageArtifacts!);
    wrongNode.artifacts[0].node = "10";
    expect(validateImageArtifacts(wrongNode, manifest, template).join(" ")).toContain("SaveImage");
  });

  it("declares the aligned still image/mask input contract", () => {
    expect(manifest.imageInputContract).toEqual({
      kind: "aligned_still_image_mask_v1",
      schemaVersion: 1,
      sourceInput: "source_image",
      maskInput: "edit_mask",
      semantics: "white_edits_black_preserves",
      dimensionMultiple: 8,
    });
    expect(manifest.routes[0].implementation).toBe("experimental");
    expect(manifest.coverage.local).toBe("experimental");
  });

  it("rejects malformed aligned still image/mask contracts", () => {
    const cases: Array<[string, (draft: CapabilityManifestV2) => void]> = [
      ["kind", draft => { (draft.imageInputContract as { kind: string }).kind = "aligned_video_mask_v1"; }],
      ["schemaVersion", draft => { (draft.imageInputContract as { schemaVersion: number }).schemaVersion = 2; }],
      ["semantics", draft => { draft.imageInputContract!.semantics = "black_edits" as never; }],
      ["zero multiple", draft => { draft.imageInputContract!.dimensionMultiple = 0; }],
      ["fractional multiple", draft => { draft.imageInputContract!.dimensionMultiple = 7.5; }],
      ["oversized multiple", draft => { draft.imageInputContract!.dimensionMultiple = 128; }],
      ["same input twice", draft => { draft.imageInputContract!.maskInput = "source_image"; }],
      ["unknown mask input", draft => { draft.imageInputContract!.maskInput = "missing_mask"; }],
      ["source not required", draft => { draft.inputs[0].required = false; }],
      ["mask as video", draft => { draft.inputs[1].representation = "video"; }],
      ["combined with video contract", draft => { draft.mediaContract = { kind: "aligned_video_mask_v1", sourceInput: "source_image", maskInput: "edit_mask" }; }],
    ];
    for (const [name, mutate] of cases) {
      const draft = structuredClone(manifest);
      mutate(draft);
      expect(validateCapability({ manifest: draft, template }).join(" "), name).toContain("aligned still image/mask contract");
    }
  });

  it("keeps all existing native workflow manifests valid", () => {
    for (const directory of readdirSync("native-workflows", { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      if (!existsSync(`native-workflows/${directory.name}/manifest.json`)) continue;
      const currentManifest = JSON.parse(readFileSync(`native-workflows/${directory.name}/manifest.json`, "utf8"));
      const currentTemplate = JSON.parse(readFileSync(`native-workflows/${directory.name}/template.api.json`, "utf8"));
      expect(validateCapability({ manifest: currentManifest, template: currentTemplate }), directory.name).toEqual([]);
    }
  });
});

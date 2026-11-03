import { describe, expect, it } from "vitest";
import type { CapabilityManifestV2, Port } from "../src/capabilities/types";
import { characterReferenceBinding, imageDraftIssues, imageDraftWithReferences, imageRunBody, isCharacterPort, restoreImageRetakeDraft, type ImageDraft } from "../src/image/image-state";
import type { CharacterReference, CharacterRecord } from "../src/team/api";

const port = (id: string, type: Port["type"] = "image", required = false): Port => ({ id, label: id, type, required, binding: { node: "1", field: "image" } });

const manifest: CapabilityManifestV2 = {
  schemaVersion: 2,
  id: "elements",
  version: "0.1.0",
  title: "InstantID SDXL character references",
  category: "identity",
  description: "Candidate character references from one face image",
  inputs: [port("reference_image", "image", true)],
  outputs: [{ id: "character_reference", label: "Candidate character reference", type: "image", required: true }],
  controls: [{ id: "prompt", label: "Prompt", type: "string", default: "portrait photograph", binding: { node: "6", field: "text" } }],
  presets: [],
  routes: [{ id: "local", execution: "local_comfy", provider: "ComfyUI", upstreamProviders: [], implementation: "implemented", workflowId: "instantid-sdxl-character", requirements: [], evidence: [] }],
  coverage: { local: "implemented", hosted: "planned" },
  licenses: { software: "Apache-2.0", weights: [] },
  sources: [],
  tickets: [],
  audioPolicies: ["mute"],
};

const reference = (ordinal: number, assetId: string, extra: Partial<CharacterReference> = {}): CharacterReference => ({
  ordinal, assetId, assetProjectId: "project-a", assetSha256: "a".repeat(64), assetMediaType: "image", assetContentType: "image/png", assetBytes: 12, assetMetadata: {}, ...extra,
});

const character: CharacterRecord = {
  id: "character-a", projectId: "project-a", elementId: "11111111-1111-4111-8111-111111111111", name: "Mara", description: "", createdAt: "2026-10-16T00:00:00.000Z",
  referencePack: { version: 1, references: [reference(1, "22222222-2222-4222-8222-222222222222"), reference(0, "33333333-3333-4333-8333-333333333333")] },
};

describe("retaking an image run", () => {
  it("restores a saved element reference with the exact resolved asset alongside ordinary inputs", () => {
    const draft = restoreImageRetakeDraft(manifest, {
      controls: { prompt: "Change the scene", seed: 42 },
      inputs: { source_image: "project-picture", reference_image: "derived-picture" },
      elementInputSnapshots: { reference_image: { validationVersion: 1, inputPort: "reference_image", elementId: "element", elementKind: "character", assetId: "original-picture", assetSha256: "a".repeat(64), assetMediaType: "image", assetProjectId: null } },
    });
    const body = imageRunBody({ projectId: "project-a", workerId: "worker", idempotencyKey: "key", routeId: "local" }, manifest, draft);
    expect(body.inputs).toEqual({ source_image: "project-picture" });
    expect(body.elementInputs).toEqual({ reference_image: { elementId: "element", assetId: "derived-picture" } });
    expect(body.controls.prompt).toBe("Change the scene");
  });

  it("keeps ordinary input assets and rejects an incomplete reference snapshot", () => {
    expect(restoreImageRetakeDraft(manifest, { controls: {}, inputs: { reference_image: "picture" } }).inputs).toEqual({ reference_image: "picture" });
    expect(() => restoreImageRetakeDraft(manifest, { controls: {}, inputs: {}, elementInputSnapshots: { reference_image: { validationVersion: 1, inputPort: "reference_image", elementId: "element", elementKind: "character", assetId: "picture", assetSha256: "a".repeat(64), assetMediaType: "image", assetProjectId: null } } })).toThrow("original reference");
  });
});

describe("a saved character as an image reference", () => {
  it("takes only reference ports", () => {
    expect(isCharacterPort(port("reference_image"))).toBe(true);
    expect(isCharacterPort(port("reference_image_2"))).toBe(true);
    expect(isCharacterPort(port("start_image"))).toBe(false);
    expect(isCharacterPort(port("source_video", "video"))).toBe(false);
  });

  it("binds the character's first picture to the port, whatever the pack order is", () => {
    expect(characterReferenceBinding(character, port("reference_image"), "project-a")).toEqual({
      elementId: "11111111-1111-4111-8111-111111111111",
      assetId: "33333333-3333-4333-8333-333333333333",
    });
    const fromLibrary: CharacterRecord = { ...character, referencePack: { version: 1, references: [reference(0, "44444444-4444-4444-8444-444444444444", { assetProjectId: null })] } };
    expect(characterReferenceBinding(fromLibrary, port("reference_image"), "project-a").assetId).toBe("44444444-4444-4444-8444-444444444444");
  });

  it("refuses a character it cannot use on this port, with a plain reason", () => {
    const otherProject: CharacterRecord = { ...character, projectId: "project-b" };
    expect(() => characterReferenceBinding(otherProject, port("reference_image"), "project-a")).toThrow("Choose a character from this project.");
    const empty: CharacterRecord = { ...character, referencePack: { version: 1, references: [] } };
    expect(() => characterReferenceBinding(empty, port("reference_image"), "project-a")).toThrow("This character has no picture to use.");
    expect(() => characterReferenceBinding({ ...character, elementId: "" }, port("reference_image"), "project-a")).toThrow("This character has no picture to use.");
    const elsewhere: CharacterRecord = { ...character, referencePack: { version: 1, references: [reference(0, "asset-away", { assetProjectId: "project-b" })] } };
    expect(() => characterReferenceBinding(elsewhere, port("reference_image"), "project-a")).toThrow("A character picture belongs to another project.");
    const notAnImage: CharacterRecord = { ...character, referencePack: { version: 1, references: [reference(0, "asset-video", { assetContentType: "video/mp4" })] } };
    expect(() => characterReferenceBinding(notAnImage, port("reference_image"), "project-a")).toThrow("A character picture does not fit this workflow.");
  });

  it("counts a character as the answer for a required reference port", () => {
    const empty: ImageDraft = { controls: { prompt: "portrait photograph" } };
    expect(imageDraftIssues(manifest, empty)).toEqual(["reference_image is required."]);
    const bound: ImageDraft = { ...empty, elementInputs: { reference_image: characterReferenceBinding(character, port("reference_image"), "project-a") } };
    expect(imageDraftIssues(manifest, bound)).toEqual([]);
  });

  it("sends the binding on the run", () => {
    const draft: ImageDraft = {
      controls: { prompt: "portrait photograph" },
      elementInputs: { reference_image: characterReferenceBinding(character, port("reference_image"), "project-a") },
    };
    const body = imageRunBody({ projectId: "project-a", workerId: "worker-a", idempotencyKey: "key-12345678", routeId: "local" }, manifest, draft);
    expect(body.elementInputs).toEqual({ reference_image: { elementId: "11111111-1111-4111-8111-111111111111", assetId: "33333333-3333-4333-8333-333333333333" } });
    expect(body.inputs).toEqual({});
    expect(body.capabilityId).toBe("elements");
    expect(imageRunBody({ projectId: "project-a", workerId: "worker-a", idempotencyKey: "key-12345678", routeId: "local" }, manifest, { controls: {} }).elementInputs).toEqual({});
  });

  it("carries the written prompt and both pictures into the selected editor",()=>{
    const result=imageDraftWithReferences({...manifest,id:"fibo2-edit"},{controls:{prompt:"Use the reference for the jacket"}},{source_image:"scene",reference_image:"jacket"});
    expect(result.controls.prompt).toBe("Use the reference for the jacket");
    expect(result.inputs).toEqual({source_image:"scene",reference_image:"jacket"});
  });

  it("sends Fibo source and reference with addressed image mentions",()=>{
    const draft:ImageDraft={controls:{prompt:"Replace @Image 1 with @Image 2"},inputs:{source_image:"scene",reference_image:"reference"}};
    const body=imageRunBody({projectId:"project-a",workerId:"worker-a",idempotencyKey:"key-12345678",routeId:"local"},{...manifest,id:"fibo2-edit",controls:[...manifest.controls,{id:"improve_prompt",label:"Improve",type:"boolean",default:true}]},draft);
    expect(body.inputs).toEqual({source_image:"scene",reference_image:"reference"});
    expect(body.controls.prompt).toBe("Replace image 1 with image 2");
    expect(body.controls.improve_prompt).toBe(false);
    expect(draft.controls.prompt).toBe("Replace @Image 1 with @Image 2");
    const implicit=imageRunBody({projectId:"project-a",workerId:"worker-a",idempotencyKey:"key-12345678",routeId:"local"},{...manifest,id:"fibo2-edit",controls:[...manifest.controls,{id:"improve_prompt",label:"Improve",type:"boolean",default:true}]},{...draft,controls:{prompt:"Use the reference"}});
    expect(implicit.controls).toMatchObject({prompt:"Use the reference",improve_prompt:false});
    const noPrompt=imageRunBody({projectId:"project-a",workerId:"worker-a",idempotencyKey:"key-12345678",routeId:"local"},{...manifest,id:"fibo2-edit",controls:[...manifest.controls,{id:"improve_prompt",label:"Improve",type:"boolean",default:true}]},{...draft,controls:{}});
    expect(noPrompt.controls.improve_prompt).toBe(false);
  });

  it("hands the chosen image and exact prompt to the model without a style preset", () => {
    const draft: ImageDraft = { controls: { prompt: "Turn the red cabin toward morning light." }, inputs: { reference_image: "asset-source" }, presetId: "old-hidden-preset" };
    const body = imageRunBody({ projectId: "project-a", workerId: "worker-a", idempotencyKey: "key-12345678", routeId: "local" }, manifest, draft);
    expect(body.inputs).toEqual({ reference_image: "asset-source" });
    expect(body.controls.prompt).toBe("Turn the red cabin toward morning light.");
    expect(body).not.toHaveProperty("presetId");
  });
});

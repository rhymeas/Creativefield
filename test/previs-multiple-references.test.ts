import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileLocal } from "../src/capabilities/compile";
import type { CapabilityBundle } from "../src/capabilities/types";
import { validateCapability } from "../src/capabilities/validate";
import { modelPromptReferences, usesH3Prompt } from "../src/team/prompt-reference";

const root = "native-workflows/previs-to-video";
const bundle = {
  manifest: JSON.parse(readFileSync(`${root}/manifest.json`, "utf8")),
  template: JSON.parse(readFileSync(`${root}/template.api.json`, "utf8")),
} as CapabilityBundle;
const base = {
  capabilityId: bundle.manifest.id,
  version: bundle.manifest.version,
  routeId: "local",
  controls: { prompt: "Use <Picture 1> on the left and <Picture 4> on the right." },
  audioPolicy: "replace" as const,
};

describe("previs-to-video references", () => {
  it("validates the existing pack and omits absent optional image nodes", () => {
    expect(validateCapability(bundle)).toEqual([]);
    const graph = compileLocal(bundle, { ...base, inputs: { source_video: "comfyfield-video.mp4", character_image: "comfyfield-first.png" } });
    expect(graph["2136"].inputs["ref_images.ref_image_0"]).toEqual(["20", 0]);
    for (const id of ["21", "22", "23"]) expect(graph[id]).toBeUndefined();
    for (const index of [1, 2, 3]) expect(graph["2136"].inputs[`ref_images.ref_image_${index}`]).toBeUndefined();
  });

  it("delivers four distinct pictures and the user's prompt to the H3 node", () => {
    const graph = compileLocal(bundle, { ...base, inputs: {
      source_video: "comfyfield-video.mp4", character_image: "comfyfield-first.png",
      reference_image: "comfyfield-second.png", reference_image_2: "comfyfield-third.png",
      reference_image_3: "comfyfield-fourth.png",
    } });
    for (const [index, file] of ["first", "second", "third", "fourth"].entries()) {
      const loader = String(20 + index);
      expect(graph[loader].inputs.image).toBe(`comfyfield-${file}.png`);
      expect(graph["2136"].inputs[`ref_images.ref_image_${index}`]).toEqual([loader, 0]);
    }
    expect(graph["2136"].inputs.prompt).toBe(base.controls.prompt);
    expect(graph["2136"].inputs["ref_videos.ref_video_0"]).toEqual(["11", 0]);
  });

  it("translates selected image mentions for H3 while retaining unmatched mentions", () => {
    expect(usesH3Prompt(bundle.manifest)).toBe(true);
    const prompt = modelPromptReferences("Use @Image 1 on the left and @Image 4 on the right; keep @Image 5.", "h3", [1, 2, 3, 4]);
    const graph = compileLocal(bundle, { ...base, controls: { prompt }, inputs: {
      source_video: "comfyfield-video.mp4", character_image: "comfyfield-first.png",
      reference_image: "comfyfield-second.png", reference_image_2: "comfyfield-third.png",
      reference_image_3: "comfyfield-fourth.png",
    } });
    expect(graph["2136"].inputs.prompt).toBe("Use <Picture 1> on the left and <Picture 4> on the right; keep @Image 5.");
  });
});

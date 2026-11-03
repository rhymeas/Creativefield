import { describe, expect, it } from "vitest";
import type { CapabilityManifestV2 } from "../src/capabilities/types";
import { capabilityPurpose, capabilitySurface, isImageWorkflow, isVideoWorkflow } from "../src/capabilities/surfaces";
import { groupModels, modelRole, nodeRole } from "../src/team/comfy-library-roles";

const manifest = (overrides: Record<string, unknown>): CapabilityManifestV2 => ({
  id: "workflow", version: "1.0.0", title: "Workflow", category: "t2v", description: "Raw manifest description.",
  inputs: [], outputs: [{ id: "video", type: "video", required: true }], controls: [], presets: [],
  coverage: { local: "implemented", hosted: "planned" }, audioPolicies: [],
  routes: [], licenses: { software: "test", weights: [] }, sources: [], tickets: [],
  ...overrides
} as unknown as CapabilityManifestV2);

describe("capability surfaces", () => {
  it("classifies workflows by what they produce", () => {
    expect(capabilitySurface(manifest({}))).toBe("video-create");
    expect(capabilitySurface(manifest({ category: "image", outputs: [{ id: "image", type: "image", required: true }] }))).toBe("image");
    expect(capabilitySurface(manifest({ category: "enhance" }))).toBe("video-enhance");
    expect(capabilitySurface(manifest({ category: "finishing" }))).toBe("video-effect");
    expect(capabilitySurface(manifest({ category: "motion" }))).toBe("motion");
    expect(capabilitySurface(manifest({ mediaContract: { kind: "aligned_video_mask_v1" } }))).toBe("video-edit");
    expect(capabilitySurface(manifest({ category: "audio", outputs: [{ id: "audio", type: "audio", required: true }] }))).toBe("audio");
  });

  it("keeps image and video pickers apart and explains the purpose", () => {
    const image = manifest({ category: "image", outputs: [{ id: "image", type: "image", required: true }] });
    const video = manifest({});
    expect(isImageWorkflow(image)).toBe(true);
    expect(isVideoWorkflow(image)).toBe(false);
    expect(isVideoWorkflow(video)).toBe(true);
    expect(capabilityPurpose(video)).toMatch(/new video/i);
    expect(capabilityPurpose(image)).toMatch(/still image/i);
  });
});

describe("ComfyUI library roles", () => {
  it("separates video and image model files inside diffusion_models", () => {
    expect(modelRole("diffusion_models", "wan2.2_ti2v_5b_fp16.safetensors").id).toBe("video");
    expect(modelRole("diffusion_models", "flux-2-klein-4b-fp8.safetensors").id).toBe("image");
    expect(modelRole("text_encoders", "umt5_xxl_fp8_e4m3fn_scaled.safetensors").id).toBe("prompt");
    expect(modelRole("upscale_models", "RealESRGAN_x4plus.pth").id).toBe("upscale");
  });

  it("groups models by role and nodes by job", () => {
    const groups = groupModels([{ name: "diffusion_models", files: ["wan2.2.safetensors", "flux2.safetensors"] }]);
    expect(groups.map(group => group.role.id).sort()).toEqual(["image", "video"]);
    expect(nodeRole({ name: "WanVaceToVideo", displayName: "Wan VACE", category: "video/conditioning", outputs: [] }).id).toBe("video");
    expect(nodeRole({ name: "SaveImage", displayName: "Save Image", category: "image", outputs: [] }).id).toBe("image");
  });
});

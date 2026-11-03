import { describe, expect, it } from "vitest";
import template from "../pipelines/i2v/wan22-ti2v-5b/template.api.json";
import manifestJson from "../pipelines/i2v/wan22-ti2v-5b/manifest.json";
import infoJson from "./fixtures/object_info.wan22.json";
import { checkReadiness, comboOptions, describeReadiness } from "../src/workflow/readiness";
import { explainPromptError } from "../src/workflow/prompt-errors";
import type { ApiGraph } from "../src/workflow/build";
import type { Manifest } from "../src/workflow/manifest";
import type { ObjectInfo } from "../src/workflow/ui-to-api";
import type { PromptRejection } from "../src/comfy/client";

const provider = { manifest: manifestJson as unknown as Manifest, template: template as unknown as ApiGraph };

/** A server that offers exactly the values the template uses, so everything is "installed". */
function installedServer(): ObjectInfo {
  const info = structuredClone(infoJson) as unknown as ObjectInfo;
  for (const node of Object.values(provider.template)) {
    const spec = info[node.class_type];
    for (const [input, value] of Object.entries(node.inputs)) {
      if (typeof value !== "string") continue;
      const def = (spec.input.required?.[input] ?? spec.input.optional?.[input]) as [unknown, Record<string, unknown>?] | undefined;
      if (!def) continue;
      if (Array.isArray(def[0])) (def[0] as string[]).push(value);
      else if (def[0] === "COMBO" && Array.isArray(def[1]?.options)) (def[1]!.options as string[]).push(value);
    }
  }
  return info;
}

/** Removes one value from a dropdown, as if the file were deleted from disk. */
function withoutOption(info: ObjectInfo, cls: string, input: string, value: string): ObjectInfo {
  const def = info[cls].input.required![input] as [string[]];
  def[0] = def[0].filter((v) => v !== value);
  return info;
}

describe("checkReadiness", () => {
  it("is ready when every node and model file is available", () => {
    const r = checkReadiness(provider, installedServer());
    expect(r).toMatchObject({ state: "ready", missingNodes: [], missingFiles: [], invalidValues: [] });
  });

  it("does not check inputs the studio controls (the start image file is chosen per job)", () => {
    // LoadImage.image is bound to the manifest, so "example.png" not being on the server is fine.
    const info = installedServer();
    (info.LoadImage.input.required!.image as [string[]])[0] = [];
    expect(checkReadiness(provider, info).state).toBe("ready");
  });

  it("reports a deleted model file as missing_models, with its folder", () => {
    const info = withoutOption(installedServer(), "VAELoader", "vae_name", "wan2.2_vae.safetensors");
    const r = checkReadiness(provider, info);
    expect(r.state).toBe("missing_models");
    expect(r.missingFiles).toEqual([{ folder: "vae", file: "wan2.2_vae.safetensors" }]);
  });

  it("lists every missing model file once", () => {
    let info = withoutOption(installedServer(), "VAELoader", "vae_name", "wan2.2_vae.safetensors");
    info = withoutOption(info, "UNETLoader", "unet_name", "wan2.2_ti2v_5B_fp16.safetensors");
    const files = checkReadiness(provider, info).missingFiles.map((f) => f.file).sort();
    expect(files).toEqual(["wan2.2_ti2v_5B_fp16.safetensors", "wan2.2_vae.safetensors"]);
  });

  it("reports a missing node class as incompatible", () => {
    const info = installedServer();
    delete (info as Record<string, unknown>).Wan22ImageToVideoLatent;
    const r = checkReadiness(provider, info);
    expect(r.state).toBe("incompatible");
    expect(r.missingNodes).toEqual(["Wan22ImageToVideoLatent"]);
  });

  it("reports an option the server does not offer (not a model file) as incompatible", () => {
    const info = withoutOption(installedServer(), "KSampler", "sampler_name", "uni_pc");
    const r = checkReadiness(provider, info);
    expect(r.state).toBe("incompatible");
    expect(r.invalidValues).toEqual([{ node: "3", nodeClass: "KSampler", input: "sampler_name", value: "uni_pc" }]);
  });

  it("is offline when the server could not be asked", () => {
    expect(checkReadiness(provider, null).state).toBe("offline");
  });

  it("describes problems in plain sentences", () => {
    const info = withoutOption(installedServer(), "VAELoader", "vae_name", "wan2.2_vae.safetensors");
    expect(describeReadiness(checkReadiness(provider, info))).toEqual(["Missing model file vae/wan2.2_vae.safetensors"]);
  });
});

describe("comboOptions", () => {
  it("reads both the list form and the COMBO form", () => {
    expect(comboOptions([["a", "b"]])).toEqual(["a", "b"]);
    expect(comboOptions(["COMBO", { options: ["x"] }])).toEqual(["x"]);
    expect(comboOptions(["INT", {}])).toBeUndefined();
    expect(comboOptions(undefined)).toBeUndefined();
  });
});

describe("explainPromptError (shapes captured from ComfyUI 0.37)", () => {
  const rejection = (partial: Partial<PromptRejection>): PromptRejection => ({ node_errors: {}, ...partial });

  it("explains a missing model file by name and folder", () => {
    const e = explainPromptError(
      rejection({
        error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation" },
        node_errors: {
          "39": {
            class_type: "VAELoader",
            errors: [
              {
                type: "value_not_in_list",
                message: "Value not in list",
                extra_info: { input_name: "vae_name", received_value: "wan2.2_vae.safetensors" },
              },
            ],
          },
        },
      }),
      provider.manifest,
      provider.template,
    );
    expect(e.title).toBe("ComfyUI could not start the job");
    expect(e.lines).toEqual(['The model file "wan2.2_vae.safetensors" is not installed. It belongs in ComfyUI/models/vae.']);
  });

  it("uses the studio's own names for controls", () => {
    const e = explainPromptError(
      rejection({
        node_errors: {
          "56": {
            class_type: "LoadImage",
            errors: [
              {
                type: "value_not_in_list",
                message: "Value not in list",
                extra_info: { input_name: "image", received_value: "gone.png" },
              },
            ],
          },
          "6": {
            class_type: "CLIPTextEncode",
            errors: [{ type: "required_input_missing", message: "Required input is missing", extra_info: { input_name: "text" } }],
          },
        },
      }),
      provider.manifest,
      provider.template,
    );
    // Numeric node IDs iterate in ascending order, so node 6 comes before node 56.
    expect(e.lines).toEqual(["Prompt is missing.", 'Start image: "gone.png" is not available on this ComfyUI.']);
  });

  it("falls back to the node class for inputs the studio does not control", () => {
    const e = explainPromptError(
      rejection({
        node_errors: {
          "3": { class_type: "KSampler", errors: [{ type: "bad_value", message: "Bad", details: "steps", extra_info: { input_name: "steps" } }] },
        },
      }),
      provider.manifest,
      provider.template,
    );
    expect(e.lines).toEqual(["KSampler steps: Bad (steps)."]);
  });

  it("explains a rejection that has no node errors", () => {
    const e = explainPromptError(
      rejection({ error: { type: "missing_node_type", message: "Cannot execute because a node is missing", details: "Node ID '#1'" } }),
      provider.manifest,
      provider.template,
    );
    expect(e.lines).toEqual(["Cannot execute because a node is missing: Node ID '#1'"]);
  });
});

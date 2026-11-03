import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertLocalGraphPolicy } from "../src/capabilities/policy";
import type { CapabilityBundle } from "../src/capabilities/types";
import { validateCapability } from "../src/capabilities/validate";

function loadPack(id: string): CapabilityBundle {
  const root = `native-workflows/${id}`;
  return {
    manifest: JSON.parse(readFileSync(`${root}/manifest.json`, "utf8")),
    template: JSON.parse(readFileSync(`${root}/template.api.json`, "utf8")),
  } as CapabilityBundle;
}

describe("Qwen Image 2.1 workflow packs", () => {
  it("loads the selectable MOSS-Image SFT test path with pinned official files", () => {
    const bundle=loadPack("moss-image-t2i");
    expect(validateCapability(bundle)).toEqual([]);
    expect(Object.keys(bundle.template!)).toHaveLength(11);
    expect(bundle.manifest.coverage.local).toBe("implemented");
    expect(bundle.manifest.controls.map(control=>control.id)).toEqual(["prompt","aspect_ratio","megapixels","batch_size","steps","cfg","seed"]);
    expect(bundle.template!["18:2"].inputs).toEqual(expect.objectContaining({type:"moss_image",clip_name:"qwen3.5_9b_w4a8_gptq.safetensors"}));
    expect(bundle.manifest.routes[0].requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({name:"moss_image_sft_int8_convrot.safetensors",version:"sha256:b4d1475bc7eeffd7b809e82ea13a1fba1fb85c4e18365af3813722faa5c0fe4f"}),
      expect.objectContaining({name:"qwen3.5_9b_w4a8_gptq.safetensors",version:"sha256:4cc6a1543ad2061806da46f35f90cadb4801dcba246c44782cf42ec0feb6407c"}),
      expect.objectContaining({name:"flux2-vae_small.safetensors",version:"sha256:d8d52ba036475f5fb07c8b435e176d3d97ebfa82f0d1a1c317f9cc1e25bd013b"}),
    ]));
    expect(bundle.manifest.routes[0].evidence.join(" ")).toMatch(/model loading, generation and image-quality qualification remain unverified/i);
    assertLocalGraphPolicy(bundle.template!);
  });

  it.each([
    ["qwen-image-21-t2i", 9, "d33a6b36d530756e26ef4e25beb17d950daaea09d295475cd65f97f5d0af3b41", "implemented"],
    ["qwen-image-21-edit", 15, "d6dd8695469c20ca5e77b4bddf981b898ee0e034f0cfc5840c86f15b812ca081", "implemented"],
  ])("loads and validates the %s graph", (id, nodeCount, sourceSha, implementation) => {
    const bundle = loadPack(id);
    expect(validateCapability(bundle)).toEqual([]);
    expect(Object.keys(bundle.template!)).toHaveLength(nodeCount);
    expect(bundle.manifest.routes).toEqual([
      expect.objectContaining({
        id: "local",
        execution: "local_comfy",
        provider: "comfy-local",
        upstreamProviders: [],
        implementation,
      }),
    ]);
    expect(bundle.manifest.outputs).toEqual([
      expect.objectContaining({ type: "image", required: true }),
    ]);
    expect(bundle.manifest.routes[0].evidence.join(" ")).toContain(sourceSha);
    expect(bundle.manifest.licenses.weights[0].license).toMatch(/non-commercial research or evaluation only/i);
    expect(JSON.stringify(bundle)).not.toMatch(/higgsfield|genjutsu|pryx/i);
    assertLocalGraphPolicy(bundle.template!);
  });

  it("loads the Qwen 2.1 multiple-angle pack with real LoRA and eight 45° presets", () => {
    const bundle = loadPack("qwen-image-21-angles");
    expect(validateCapability(bundle)).toEqual([]);
    expect(Object.keys(bundle.template!)).toHaveLength(13);
    expect(bundle.manifest.presets.map(preset => preset.id)).toEqual([
      "front-left-quarter", "left-side", "back-left-quarter", "back",
      "back-right-quarter", "right-side", "front-right-quarter", "high-angle",
    ]);
    expect(bundle.manifest.presets.every(preset => String(preset.values.prompt).startsWith("<mva>"))).toBe(true);
    expect(bundle.manifest.presets.every(preset => /background color/i.test(String(preset.values.prompt)))).toBe(true);
    expect(bundle.manifest.version).toBe("0.2.0");
    const lora = Object.values(bundle.template!).find(node => node.class_type === "LoraLoaderModelOnly");
    expect(lora?.inputs.lora_name).toBe("qwen21_multiple_angles_v2.safetensors");
    expect(bundle.manifest.routes[0].requirements).toContainEqual(expect.objectContaining({
      id: "model:qwen21-multiple-angles-v2",
      kind: "model",
      location: "loras",
    }));
    assertLocalGraphPolicy(bundle.template!);
  });

  it("keeps CFG 1 without presenting a negative-prompt control", () => {
    for (const id of ["qwen-image-21-t2i", "qwen-image-21-edit"]) {
      const { manifest, template } = loadPack(id);
      expect(manifest.controls.map(control => control.id)).not.toContain("negative");
      expect(Object.values(template!).find(node => node.class_type === "KSampler")?.inputs.cfg).toBe(1);
    }
  });

  it("pins the qualified text-to-image graph and scopes its readiness claim", () => {
    const root = "native-workflows/qwen-image-21-t2i";
    const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, "utf8")) as CapabilityBundle["manifest"];
    const canonicalGraph = readFileSync(`${root}/template.api.json`, "utf8").replaceAll("\r\n", "\n");
    const readme = readFileSync(`${root}/README.md`, "utf8");
    const evidence = manifest.routes[0].evidence.join(" ");

    expect(createHash("sha256").update(canonicalGraph).digest("hex")).toBe("56820925cb5999068f70e1e0c04af040b235acb41e610d78b97fe1b46cdd7dd7");
    expect(evidence).toContain("comfyui-workflow-templates-json 0.1.92");
    expect(evidence).toContain("56820925cb5999068f70e1e0c04af040b235acb41e610d78b97fe1b46cdd7dd7");
    expect(manifest.sources).toContainEqual(expect.objectContaining({ url: "https://pypi.org/project/comfyui-workflow-templates-json/0.1.92/" }));
    expect(manifest.description).toMatch(/currently qualified local ComfyUI 0\.37\.0 worker/i);
    expect(manifest.description).toMatch(/filenames, not model hashes or the ComfyUI version/i);
    expect(readme).toContain("593103825222985");
    expect(readme).not.toMatch(/not runtime-qualified|route from `experimental`/i);
  });

  it("loads and validates the flux2-klein-t2i graph (now FLUX 3 Klein) and pins its qualification", () => {
    const bundle = loadPack("flux2-klein-t2i");
    expect(validateCapability(bundle)).toEqual([]);
    expect(Object.keys(bundle.template!)).toHaveLength(30);
    // FLUX 3 Klein is not proven on Comfy Cloud, so the pack runs on this computer only.
    expect(bundle.manifest.routes).toEqual([
      expect.objectContaining({ id: "local", execution: "local_comfy", provider: "comfy-local", upstreamProviders: [], implementation: "implemented" }),
    ]);
    expect(bundle.manifest.controls.map(control => control.id)).toEqual(["prompt", "aspect_ratio", "megapixels", "batch_size", "steps", "seed", "improve_prompt"]);
    expect(bundle.manifest.routes[0].evidence.join(" ")).toContain("flux3_klein_int8_t2i.json");
    expect(JSON.stringify(bundle)).not.toMatch(/higgsfield|genjutsu|pryx/i);
    assertLocalGraphPolicy(bundle.template!);
    const canonicalGraph = readFileSync("native-workflows/flux2-klein-t2i/template.api.json", "utf8").replaceAll("\r\n", "\n");
    expect(createHash("sha256").update(canonicalGraph).digest("hex")).toBe("b237c8008ced2680953fb2a974357c62c5a5eb02badf928c9aa156643254a3de");
  });

  it("binds a target plus up to three references and omits the editor-only comparison node", () => {
    const { manifest, template } = loadPack("qwen-image-21-edit");
    expect(manifest.inputs).toEqual([
      expect.objectContaining({ id: "source_image", required: true, binding: { node: "470", field: "image" } }),
      expect.objectContaining({ id: "reference_image", type: "image", required: true, binding: { node: "475", field: "image" } }),
      expect.objectContaining({ id: "reference_image_2", required: false, omitWhenMissing: true }),
      expect.objectContaining({ id: "reference_image_3", required: false, omitWhenMissing: true }),
    ]);
    expect(Object.values(template!).map(node => node.class_type)).not.toContain("ImageCompare");
    expect(template!["459:474"].inputs).toEqual(expect.objectContaining({
      "images.image_1": ["470", 0],
      "images.image_2": ["475", 0],
    }));
  });

  it("records the graph-execution MVP qualification for VACE Canny restyle", () => {
    const bundle = loadPack("vace-canny-restyle");
    expect(validateCapability(bundle)).toEqual([]);
    expect(Object.keys(bundle.template!)).toHaveLength(20);
    expect(bundle.manifest.routes).toEqual([
      expect.objectContaining({ id: "local", execution: "local_comfy", provider: "comfy-local", upstreamProviders: [], implementation: "implemented" }),
    ]);
    expect(bundle.manifest.coverage.local).toBe("implemented");
    expect(bundle.manifest.controls.map(control => control.id)).toEqual(["prompt", "negative", "seed", "strength", "canny_low_threshold", "canny_high_threshold"]);
    expect(bundle.manifest.inputs).toEqual([
      expect.objectContaining({ id: "source_video", type: "video", required: true, binding: { node: "4", field: "file" } }),
    ]);
    const evidence = bundle.manifest.routes[0].evidence.join(" ");
    expect(evidence).toContain("Graph execution qualification 2026-10-18");
    expect(evidence).toContain("7641ccb72e2b83f88b90df72097ddf0e520cc509eabe918e81aee6ddb4849124");
    expect(evidence).toMatch(/not proven|unqualified/i);
    expect(JSON.stringify(bundle)).not.toMatch(/higgsfield|genjutsu|pryx/i);
    assertLocalGraphPolicy(bundle.template!);
    const canonicalGraph = readFileSync("native-workflows/vace-canny-restyle/template.api.json", "utf8").replaceAll("\r\n", "\n");
    expect(createHash("sha256").update(canonicalGraph).digest("hex")).toBe("bd875586dddc83a2cc4e9b987d31b086615e7fa14103a6ebee368e3c4ac97695");
  });

  it("records GPU execution of the VACE preprocessed-depth candidate", () => {
    const bundle = loadPack("vace-depth-restyle");
    expect(validateCapability(bundle)).toEqual([]);
    expect(Object.keys(bundle.template!)).toHaveLength(18);
    expect(bundle.manifest.routes).toEqual([
      expect.objectContaining({ id: "local", execution: "local_comfy", provider: "comfy-local", upstreamProviders: [], implementation: "implemented" }),
    ]);
    expect(bundle.manifest.coverage.local).toBe("implemented");
    expect(bundle.manifest.controls.map(control => control.id)).toEqual(["prompt", "negative", "seed", "strength"]);
    expect(bundle.manifest.inputs).toEqual([
      expect.objectContaining({ id: "source_video", type: "video", required: true, binding: { node: "4", field: "file" } }),
      expect.objectContaining({ id: "depth_video", type: "video", required: true, binding: { node: "6", field: "file" } }),
    ]);
    const evidence = bundle.manifest.routes[0].evidence.join(" ");
    expect(evidence).toContain("Graph executed 2026-10-19");
    expect(evidence).toContain("df22aa5b986c7dd93bf5ba6a43a6a730ad9e4c8a0462c2433b31f94e479d91a6");
    expect(evidence).toMatch(/not proven|unqualified/i);
    expect(JSON.stringify(bundle)).not.toMatch(/higgsfield|genjutsu|pryx/i);
    assertLocalGraphPolicy(bundle.template!);
    const canonicalGraph = readFileSync("native-workflows/vace-depth-restyle/template.api.json", "utf8").replaceAll("\r\n", "\n");
    expect(createHash("sha256").update(canonicalGraph).digest("hex")).toBe("e948f090c2e84d694e853f5ae00203e751a595b7f63dce8d3a81feea308b3c18");
  });

  it("keeps the FILM interpolation pack bound to its qualified graph", () => {
    const bundle = loadPack("film-frame-interpolation");
    expect(validateCapability(bundle)).toEqual([]);
    expect(Object.keys(bundle.template!)).toHaveLength(6);
    expect(bundle.manifest.category).toBe("enhance");
    expect(bundle.manifest.routes).toEqual([
      expect.objectContaining({ id: "local", execution: "local_comfy", provider: "comfy-local", upstreamProviders: [], implementation: "implemented" }),
    ]);
    expect(bundle.manifest.coverage.local).toBe("implemented");
    expect(bundle.manifest.inputs).toEqual([
      expect.objectContaining({ id: "source_video", type: "video", required: true, binding: { node: "1", field: "file" } }),
    ]);
    expect(bundle.manifest.controls.map(control => control.id)).toEqual(["multiplier", "output_fps"]);
    expect(bundle.template!["4"].inputs).toEqual(expect.objectContaining({ multiplier: 2 }));
    expect(bundle.template!["5"].inputs).toEqual(expect.objectContaining({ fps: 32 }));
    expect(bundle.manifest.audioPolicies).toEqual(["mute"]);
    const evidence = bundle.manifest.routes[0].evidence.join(" ");
    expect(evidence).toContain("GPU-qualified 2026-10-19");
    expect(evidence).toContain("656294eba3d03e30685f383201899956a03105847b83f3112bc4f6f3b1058ce2");
    expect(evidence).toMatch(/not proven|unqualified/i);
    expect(bundle.manifest.routes[0].requirements).toContainEqual(expect.objectContaining({
      kind: "model",
      name: "film_net_fp16.safetensors",
      location: "frame_interpolation",
      version: "sha256:f226e51375dc839d4b40e5c3d63da560dd1ea1c962364ec78f5adf2d05db05c0",
    }));
    expect(JSON.stringify(bundle)).not.toMatch(/higgsfield|genjutsu|pryx/i);
    assertLocalGraphPolicy(bundle.template!);
    const canonicalGraph = readFileSync("native-workflows/film-frame-interpolation/template.api.json", "utf8").replaceAll("\r\n", "\n");
    expect(createHash("sha256").update(canonicalGraph).digest("hex")).toBe("9418f3e6d1d316400dd8206095376f1caec3570fd6d55cc9b7afc68d75874ec9");
  });

  it("loads the image edit pack (now FLUX 3 Klein) and pins its qualification", () => {
    const bundle = loadPack("flux2-klein-edit");
    expect(validateCapability(bundle)).toEqual([]);
    expect(Object.keys(bundle.template!)).toHaveLength(40);
    expect(bundle.manifest.routes).toEqual([
      expect.objectContaining({ id: "local", execution: "local_comfy", provider: "comfy-local", upstreamProviders: [], implementation: "implemented" }),
    ]);
    expect(bundle.manifest.coverage.local).toBe("implemented");
    expect(bundle.manifest.inputs).toEqual([
      expect.objectContaining({ id: "source_image", type: "image", required: true, binding: { node: "133", field: "image" } }),
    ]);
    expect(bundle.manifest.controls.map(control => control.id)).toEqual(["prompt", "megapixels", "steps", "seed", "improve_prompt"]);
    expect(bundle.template!["128:107"].inputs).toEqual(expect.objectContaining({ steps: 16 }));
    expect(bundle.template!["145:138"].inputs).toEqual(expect.objectContaining({ megapixels: 1 }));
    expect(bundle.manifest.routes[0].evidence.join(" ")).toContain("flux3_klein_int8_i2i.json");
    expect(JSON.stringify(bundle)).not.toMatch(/higgsfield|genjutsu|pryx/i);
    assertLocalGraphPolicy(bundle.template!);
    const canonicalGraph = readFileSync("native-workflows/flux2-klein-edit/template.api.json", "utf8").replaceAll("\r\n", "\n");
    expect(createHash("sha256").update(canonicalGraph).digest("hex")).toBe("dc4d3807759edf22c4ab6c1926202235fcc6dba6cf0aba96d120506e863491f8");
  });

  it("loads the SAM 3.1 segment pack and pins its model", () => {
    const bundle = loadPack("sam3-image-segment");
    expect(validateCapability(bundle)).toEqual([]);
    expect(Object.keys(bundle.template!)).toHaveLength(6);
    expect(bundle.manifest.inputs).toEqual([expect.objectContaining({ id: "source_image", type: "image", required: true, binding: { node: "1", field: "image" } })]);
    expect(bundle.manifest.controls.map((control) => control.id)).toEqual(["prompt", "threshold", "individual_masks"]);
    expect(bundle.manifest.routes[0].requirements).toContainEqual(expect.objectContaining({
      kind: "model", name: "sam3.1_multiplex_fp16.safetensors", location: "checkpoints",
      version: "sha256:9ba99c92703c2e8b4f47de2d34a539bb8e18923049e238b780d70dbe6368eb03",
    }));
    expect(bundle.manifest.routes[0].evidence.join(" ")).toMatch(/not proven/i);
    assertLocalGraphPolicy(bundle.template!);
  });
});

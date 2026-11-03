import { describe, expect, it } from "vitest";
import { compileLocal } from "../src/capabilities/compile";
import { capabilityReadiness } from "../src/capabilities/readiness";
import type { CapabilityBundle } from "../src/capabilities/types";
import type { EffectRecipe } from "../server/effect-recipes";
import { loadEffectRecipeCatalogue, validateEffectRecipe } from "../server/effect-recipes";

/** The reference restyle recipe as the server loads it: straight from its pack folder, no test copy. */
async function referenceBundle() {
  const loaded = (await loadEffectRecipeCatalogue()).find(bundle => bundle.recipe.id === "vace-reference-restyle");
  if (!loaded) throw new Error("Reference restyle recipe is missing from its pack folder");
  return loaded;
}

function nodeOf(capability: CapabilityBundle, classType: string) {
  return Object.values(capability.template!).find(node => node.class_type === classType)!;
}

describe("FIN-03 effect recipe catalogue", () => {
  it("loads the Canny, depth and reference recipes against their real graphs", async () => {
    const catalogue = await loadEffectRecipeCatalogue();
    expect(catalogue.map(bundle => bundle.recipe.id)).toEqual(["vace-canny-restyle", "vace-depth-restyle", "vace-reference-restyle"]);
    for (const bundle of catalogue) {
      expect(validateEffectRecipe(bundle.recipe, bundle.capability)).toEqual([]);
      expect(bundle.recipe.schemaVersion).toBe(1);
      expect(bundle.recipe.qualification).toBe("graph-execution");
      expect(bundle.capability.manifest.inputs.every(input => input.type === "video" || input.type === "image")).toBe(true);
      expect(bundle.capability.manifest.outputs.every(output => output.type === "video")).toBe(true);
      expect(bundle.capability.manifest.audioPolicies).toEqual(["mute"]);
      expect(bundle.capability.manifest.timing).toBeUndefined();
      expect(Object.values(bundle.capability.template!).filter(node => node.class_type === "CreateVideo")).toHaveLength(1);
      expect(Object.values(bundle.capability.template!).filter(node => node.class_type === "SaveVideo")).toHaveLength(1);
      for (const input of bundle.capability.manifest.inputs) {
        expect(bundle.capability.template?.[input.binding!.node].inputs).toHaveProperty(input.binding!.field);
      }
      for (const control of bundle.capability.manifest.controls) {
        expect(bundle.capability.template?.[control.binding!.node].inputs).toHaveProperty(control.binding!.field);
      }
    }
  });

  it("enables graph-executed Canny and preprocessed-depth routes when their local prerequisites are ready", async () => {
    for (const { capability } of await loadEffectRecipeCatalogue()) {
      const requirements = capability.manifest.routes[0].requirements;
      const readiness = capabilityReadiness(capability.manifest, "local", {
        online: true,
        nodes: requirements.filter(item => item.kind === "node").map(item => item.name),
        models: requirements.filter(item => item.kind === "model").map(item => `${item.location}/${item.name}`),
        credentials: [],
      });
      const compile=()=>compileLocal(capability, {
        capabilityId: capability.manifest.id,
        version: capability.manifest.version,
        routeId: "local",
        inputs: Object.fromEntries(capability.manifest.inputs.map(input => [input.id, `comfyfield-${input.id}.mp4`])),
        controls: {},
        audioPolicy: "mute",
      });
      expect(readiness).toMatchObject({state:"ready",reasons:[]});
      expect(compile()["4"].inputs.file).toBe("comfyfield-source_video.mp4");
      if(capability.manifest.id==="vace-depth-restyle")expect(compile()["6"].inputs.file).toBe("comfyfield-depth_video.mp4");
    }
  });

  it("declares every node the canny look uses, so readiness waits for the resize and batch nodes", async () => {
    const { capability } = (await loadEffectRecipeCatalogue()).find(bundle => bundle.recipe.id === "vace-canny-restyle")!;
    const requirements = capability.manifest.routes[0].requirements;
    const declared = requirements.filter(item => item.kind === "node").map(item => item.name);
    const used = [...new Set(Object.values(capability.template!).map(node => node.class_type))];
    expect(declared.filter(name => !used.includes(name))).toEqual([]);
    expect(used.filter(name => !declared.includes(name))).toEqual([]);
    const models = requirements.filter(item => item.kind === "model").map(item => `${item.location}/${item.name}`);
    const withoutNodes = declared.filter(name => name !== "ImageFromBatch" && name !== "ResizeImageMaskNode");
    expect(capabilityReadiness(capability.manifest, "local", { online: true, nodes: withoutNodes, models, credentials: [] }).state).toBe("install_required");
  });

  it("snaps any source size to multiples of 16 before Wan VACE", async () => {
    for (const bundle of (await loadEffectRecipeCatalogue()).filter(b => ["vace-canny-restyle", "vace-depth-restyle"].includes(b.recipe.id))) {
      const graph = bundle.capability.template!, vace = Object.values(graph).find(node => node.class_type === "WanVaceToVideo")!;
      const size = graph[String((vace.inputs.width as unknown[])[0])];
      expect(graph[String((size.inputs.image as unknown[])[0])]).toMatchObject({ class_type: "ResizeImageMaskNode", inputs: { "resize_type.multiple": 16 } });
    }
  });
  it("feeds only caller-supplied preprocessed depth frames to the depth candidate", async () => {
    const { recipe, capability } = (await loadEffectRecipeCatalogue()).find(bundle => bundle.recipe.id === "vace-depth-restyle")!;
    const graph = capability.template!;
    const depthBinding = capability.manifest.inputs.find(input => input.id === "depth_video")!.binding!;
    expect(recipe.inputs.find(input => input.id === "depth_video")?.role).toBe("preprocessed_depth_control");
    expect(graph[depthBinding.node].class_type).toBe("LoadVideo");
    expect(Object.values(graph).some(node => /depth/i.test(node.class_type))).toBe(false);
    const depthComponents = Object.entries(graph).find(([, node]) => node.class_type === "GetVideoComponents" && JSON.stringify(node.inputs.video) === JSON.stringify([depthBinding.node, 0]))!;
    const vace = Object.values(graph).find(node => node.class_type === "WanVaceToVideo")!;
    // The depth frames reach VACE through one size snap (sides divisible by 16), never through anything that changes content.
    const snap = graph[String((vace.inputs.control_video as unknown[])[0])];
    expect(snap).toMatchObject({ class_type: "ResizeImageMaskNode", inputs: { input: [depthComponents[0], 0], resize_type: "scale to multiple", "resize_type.multiple": 16 } });
    expect(recipe.limitations.join(" ")).toMatch(/does not derive depth/i);
  });

  it("rejects edges, dimensions and FPS taken from a different source branch",async()=>{
    for(const loaded of await loadEffectRecipeCatalogue()){
      const changed=structuredClone(loaded.capability),graph=changed.template!;
      const video=Object.values(graph).find(node=>node.class_type==="CreateVideo")!;
      video.inputs.fps=24;
      expect(validateEffectRecipe(loaded.recipe,changed).join(" ")).toContain("must derive from the selected source");
      const changedSize=structuredClone(loaded.capability),vace=Object.values(changedSize.template!).find(node=>node.class_type==="WanVaceToVideo")!;vace.inputs.length=17;
      expect(validateEffectRecipe(loaded.recipe,changedSize).join(" ")).toContain("must derive from the selected source");
      if(loaded.recipe.id==="vace-canny-restyle"){
        const foreign=structuredClone(loaded.capability);Object.values(foreign.template!).find(node=>node.class_type==="Canny")!.inputs.image=["99",0];
        expect(validateEffectRecipe(loaded.recipe,foreign).join(" ")).toContain("edges must derive from the selected source");
      }
    }
  });

  it("rejects invented timing controls and broken depth/source/license evidence", async () => {
    const loaded = (await loadEffectRecipeCatalogue()).find(bundle => bundle.recipe.id === "vace-depth-restyle")!;
    const timing = structuredClone(loaded.recipe) as EffectRecipe;
    timing.controls.push({ id: "duration", role: "timeline_duration", enabled: true });
    expect(validateEffectRecipe(timing, loaded.capability).join(" ")).toMatch(/timing|controls do not match/i);

    const derived = structuredClone(loaded.recipe) as EffectRecipe;
    derived.inputs[1].role = "derived_depth";
    expect(validateEffectRecipe(derived, loaded.capability).join(" ")).toContain("preprocessed depth video directly");

    const unsupportedClaim = structuredClone(loaded.recipe) as EffectRecipe;
    unsupportedClaim.qualification = "qualified" as "experimental";
    expect(validateEffectRecipe(unsupportedClaim, loaded.capability).join(" ")).toContain("qualification is invalid");

    const changedLicense = structuredClone(loaded.recipe) as EffectRecipe;
    changedLicense.licenses.software = "Unknown";
    expect(validateEffectRecipe(changedLicense, loaded.capability).join(" ")).toContain("license evidence");

    const extraArtifact = structuredClone(loaded.capability);
    extraArtifact.template!["99"] = structuredClone(extraArtifact.template!["16"]);
    expect(validateEffectRecipe(loaded.recipe, extraArtifact).join(" ")).toContain("exactly one CreateVideo-to-SaveVideo");

    const audioAttached = structuredClone(loaded.capability);
    audioAttached.template!["15"].inputs.audio = ["5", 1];
    expect(validateEffectRecipe(loaded.recipe, audioAttached).join(" ")).toContain("must not attach audio");
  });
});

describe("reference restyle recipe guard", () => {
  it("loads the reference recipe from its own pack folder with no errors", async () => {
    const { recipe, capability } = await referenceBundle();
    expect(recipe.version).toBe("0.3.0");
    expect(recipe.version).toBe(capability.manifest.version);
    expect(recipe.qualification).toBe("graph-execution");
    expect(recipe.inputs.map(input => [input.id, input.type])).toEqual([["source_video", "video"], ["style_reference", "image"]]);
    expect(recipe.controls.map(control => control.id)).toEqual(capability.manifest.controls.map(control => control.id));
    expect(validateEffectRecipe(recipe, capability)).toEqual([]);

    const withoutRun = structuredClone(capability);
    withoutRun.manifest.routes[0].evidence = withoutRun.manifest.routes[0].evidence.filter(item => !/output structure/i.test(item));
    expect(validateEffectRecipe(recipe, withoutRun).join(" ")).toContain("recorded output-structure hash evidence");
  });

  it("rejects a reference image taken from the control video or the source frames", async () => {
    const { recipe, capability } = await referenceBundle();
    for (const swapped of [["6", 0], ["5", 0], ["20", 0]] as const) {
      const changed = structuredClone(capability);
      nodeOf(changed, "WanVaceToVideo").inputs.reference_image = [...swapped];
      expect(validateEffectRecipe(recipe, changed).join(" ")).toContain("reference image must come from the style reference input");
    }
    const throughFit = structuredClone(capability);
    nodeOf(throughFit, "WanVaceToVideo").inputs.reference_image = ["19", 0];
    expect(validateEffectRecipe(recipe, throughFit).join(" ")).toContain("reference image must come from the style reference input");

    const styleBindingOnEdges = structuredClone(capability);
    styleBindingOnEdges.manifest.inputs.find(input => input.id === "style_reference")!.binding = { node: "6", field: "image" };
    expect(validateEffectRecipe(recipe, styleBindingOnEdges).join(" ")).toContain("reference image must come from the style reference input");
  });

  it("rejects edges taken from the style image, a style image typed as video, and a foreign frame rate", async () => {
    const { recipe, capability } = await referenceBundle();

    const edgesFromStyle = structuredClone(capability);
    nodeOf(edgesFromStyle, "Canny").inputs.image = ["16", 0];
    expect(validateEffectRecipe(recipe, edgesFromStyle).join(" ")).toContain("edges must derive from the selected source");

    const styleAsVideo = structuredClone(recipe) as EffectRecipe;
    styleAsVideo.inputs[1].type = "video";
    expect(validateEffectRecipe(styleAsVideo, capability).join(" ")).toContain("inputs do not match the capability");

    const foreignFps = structuredClone(capability);
    nodeOf(foreignFps, "CreateVideo").inputs.fps = 24;
    expect(validateEffectRecipe(recipe, foreignFps).join(" ")).toContain("must derive from the selected source");
  });
});

import { readdir, readFile } from "node:fs/promises";
import type { ApiGraph } from "../src/workflow/build";
import type { CapabilityBundle, CapabilityManifestV2 } from "../src/capabilities/types";
import { assertLocalGraphPolicy } from "../src/capabilities/policy";
import { validateCapability } from "../src/capabilities/validate";

export type EffectRecipe = {
  schemaVersion: 1;
  id: string;
  version: string;
  title: string;
  capability: { id: string; version: string; routeId: string };
  qualification: "experimental" | "graph-execution";
  inputs: Array<{ id: string; role: string; type: "video" | "image"; required: boolean }>;
  outputs: Array<{ id: string; role: string; type: "video"; required: boolean }>;
  controls: Array<{ id: string; role: string; enabled: boolean }>;
  sources: CapabilityManifestV2["sources"];
  licenses: CapabilityManifestV2["licenses"];
  limitations: string[];
};

export type EffectRecipeBundle = { recipe: EffectRecipe; capability: CapabilityBundle };

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function link(value: unknown, node: string, output = 0): boolean {
  return Array.isArray(value) && value.length === 2 && value[0] === node && value[1] === output;
}

/** Frames of a GetVideoComponents node (or an image of a LoadImage node), directly or through steps that only fit
 * them to Wan VACE: a rescale (pixel budget, sides divisible by 16) or keeping the leading frames. Content and
 * timing still come from that source. */
function framesOf(template: ApiGraph, value: unknown, components: string, depth = 0): boolean {
  if (link(value, components)) return true;
  if (!Array.isArray(value) || value[1] !== 0 || depth > 3) return false;
  const node = template[String(value[0])];
  if (node?.class_type === "ResizeImageMaskNode" && ["scale to multiple", "scale total pixels"].includes(String(node.inputs.resize_type))) return framesOf(template, node.inputs.input, components, depth + 1);
  if (node?.class_type === "ImageFromBatch" && node.inputs.batch_index === 0) return framesOf(template, node.inputs.image, components, depth + 1);
  return false;
}

function graphNodeForInput(graph: ApiGraph, manifest: CapabilityManifestV2, id: string) {
  const binding = manifest.inputs.find(input => input.id === id)?.binding;
  return binding ? graph[binding.node] : undefined;
}

/** Validate the FIN-03 recipe contract against its exact, server-owned capability graph.
 * Recipes are metadata over trusted native workflows, never an arbitrary graph import path. */
export function validateEffectRecipe(value: unknown, capability: CapabilityBundle): string[] {
  const errors: string[] = [];
  if (!object(value)) return ["Effect recipe must be an object"];
  const recipe = value as Partial<EffectRecipe>;
  const manifest = capability.manifest;
  const template = capability.template;
  if (recipe.schemaVersion !== 1) errors.push("Unsupported effect recipe schema version");
  if (!recipe.id || !/^[a-z0-9][a-z0-9._-]*$/.test(recipe.id)) errors.push("Invalid effect recipe id");
  if (!recipe.version || !recipe.title) errors.push("Effect recipe version and title are required");
  if (!object(recipe.capability)) errors.push("Effect recipe capability reference is required");
  else if (recipe.capability.id !== manifest.id || recipe.capability.version !== manifest.version) errors.push("Effect recipe capability revision mismatch");
  const graphExecution = recipe.qualification === "graph-execution";
  if (!graphExecution && recipe.qualification !== "experimental") errors.push("Effect recipe qualification is invalid");
  if (manifest.category !== "finishing" || manifest.coverage.local !== (graphExecution ? "implemented" : "experimental")) errors.push("Effect capability coverage must match its verified qualification level");
  const route = manifest.routes.find(candidate => candidate.id === recipe.capability?.routeId);
  if (!route || route.execution !== "local_comfy" || route.implementation !== (graphExecution ? "implemented" : "experimental") || route.workflowId !== manifest.id) {
    errors.push("Effect recipe must reference a local route matching its verified qualification level");
  }
  if (graphExecution && !route?.evidence.some(item => /output structure/i.test(item) && /sha-256 [a-f0-9]{64}/i.test(item))) errors.push("Graph-execution recipes need recorded output-structure hash evidence");
  errors.push(...validateCapability(capability));
  if (!template) errors.push("Effect recipe capability is missing its workflow graph");
  else try { assertLocalGraphPolicy(template); } catch (error) { errors.push(String(error)); }

  const recipeInputs = Array.isArray(recipe.inputs) ? recipe.inputs : [];
  const recipeOutputs = Array.isArray(recipe.outputs) ? recipe.outputs : [];
  const recipeControls = Array.isArray(recipe.controls) ? recipe.controls : [];
  if (!Array.isArray(recipe.inputs) || !recipeInputs.length) errors.push("Effect recipe requires video inputs");
  if (!Array.isArray(recipe.outputs) || !recipeOutputs.length) errors.push("Effect recipe requires a video output");
  if (!Array.isArray(recipe.controls)) errors.push("Effect recipe controls are required");
  if (recipeInputs.some(input => !object(input) || !(input.type === "video" || input.type === "image") || input.required !== true)) errors.push("Effect recipe inputs must be required videos or images");
  if (recipeOutputs.some(output => !object(output) || output.type !== "video" || output.required !== true)) errors.push("Effect recipe outputs must be required videos");
  if (manifest.inputs.some(input => !(input.type === "video" || input.type === "image") || !input.required) || manifest.outputs.some(output => output.type !== "video" || !output.required)) errors.push("Effect capabilities take required video or image inputs and one video output");
  if (!sameJson(recipeInputs.map(input => [input.id, input.type]), manifest.inputs.map(input => [input.id, input.type]))) errors.push("Effect recipe inputs do not match the capability");
  if (!sameJson(recipeOutputs.map(output => output.id), manifest.outputs.map(output => output.id))) errors.push("Effect recipe outputs do not match the capability");
  if (recipeOutputs.length !== 1 || manifest.outputs.length !== 1) errors.push("Effect recipes must expose exactly one video output");
  const enabledControls = recipeControls.filter(control => object(control) && control.enabled === true).map(control => control.id);
  const manifestControls = manifest.controls.filter(control => !control.disabledReason).map(control => control.id);
  if (recipeControls.some(control => !object(control) || control.enabled !== true)) errors.push("Effect recipe controls cannot be placeholders or disabled entries");
  if (!sameJson(enabledControls, manifestControls)) errors.push("Effect recipe controls do not match the enabled capability controls");
  const timingName = /(^|_)(time|timing|timeline|segment|start|end|duration|length|fps|frame)(_|$)/i;
  if ("timing" in value || manifest.timing || [...recipeControls.map(control => control.id), ...manifest.controls.map(control => control.id)].some(id => timingName.test(id))) {
    errors.push("Effect recipes cannot expose timing without a qualified segment or timeline binding");
  }
  if (manifest.audioPolicies.length !== 1 || manifest.audioPolicies[0] !== "mute") errors.push("Experimental effect recipes must be explicitly mute-only");
  if (!Array.isArray(recipe.sources) || !recipe.sources.length || !sameJson(recipe.sources, manifest.sources)) errors.push("Effect recipe source evidence must match the capability");
  if (!object(recipe.licenses) || !sameJson(recipe.licenses, manifest.licenses)) errors.push("Effect recipe license evidence must match the capability");
  if (!Array.isArray(recipe.limitations) || !recipe.limitations.some(limit => /unqualified/i.test(limit))) errors.push("Effect recipe must disclose its unqualified state");
  if (graphExecution && !recipe.limitations?.some(limit => /quality.*unqualified/i.test(limit))) errors.push("Graph-execution recipes must disclose that effect quality remains unqualified");
  if (!graphExecution && (!route?.evidence.length || !route.evidence.some(item => /unrun|unqualified|not.+qualified/i.test(item)))) errors.push("Experimental effect route must carry unavailable-state evidence");

  if (template) {
    const saveVideos = Object.entries(template).filter(([, node]) => node.class_type === "SaveVideo");
    const createVideos = Object.entries(template).filter(([, node]) => node.class_type === "CreateVideo");
    if (saveVideos.length !== 1 || createVideos.length !== 1 || !link(saveVideos[0]?.[1].inputs.video, createVideos[0]?.[0])) {
      errors.push("Effect recipes must have exactly one CreateVideo-to-SaveVideo artifact path");
    }
    if (createVideos.some(([, node]) => "audio" in node.inputs)) errors.push("Experimental effect recipes must not attach audio");
  }

  const edgeRecipes = ["vace-canny-restyle", "vace-reference-restyle"];
  if (template && edgeRecipes.includes(recipe.id ?? "")) {
    const canny = Object.entries(template).find(([, node]) => node.class_type === "Canny");
    const vace = Object.values(template).find(node => node.class_type === "WanVaceToVideo");
    if (!canny || !vace || !link(vace.inputs.control_video, canny[0])) errors.push("Canny recipe must bind derived edges to VACE control video");
    const sourceId=manifest.inputs.find(input=>input.id==="source_video")?.binding?.node;
    const sourceComponents=sourceId&&Object.entries(template).find(([,node])=>node.class_type==="GetVideoComponents"&&link(node.inputs.video,sourceId));
    if(!sourceComponents||!canny||!framesOf(template,canny[1].inputs.image,sourceComponents[0]))errors.push("Canny edges must derive from the selected source video");
  }
  if (template && recipe.id === "vace-reference-restyle") {
    const styleId = manifest.inputs.find(input => input.id === "style_reference")?.binding?.node;
    const style = styleId ? template[styleId] : undefined;
    const sourceId = manifest.inputs.find(input => input.id === "source_video")?.binding?.node;
    const sourceComponents = sourceId && Object.entries(template).find(([, node]) => node.class_type === "GetVideoComponents" && link(node.inputs.video, sourceId));
    const vace = Object.values(template).find(node => node.class_type === "WanVaceToVideo");
    const canny = Object.values(template).find(node => node.class_type === "Canny");
    const reference = vace?.inputs.reference_image;
    if (!styleId || style?.class_type !== "LoadImage" || !vace || !framesOf(template, reference, styleId) || framesOf(template, reference, sourceComponents?.[0] ?? "")) {
      errors.push("VACE reference image must come from the style reference input, not the control video");
    }
    if (framesOf(template, canny?.inputs.image, styleId ?? "")) errors.push("Canny edges must derive from the selected source video");
  }
  if(template&&["vace-canny-restyle","vace-depth-restyle","vace-reference-restyle"].includes(recipe.id??"")){
    const sourceId=manifest.inputs.find(input=>input.id==="source_video")?.binding?.node;
    const components=sourceId&&Object.entries(template).find(([,node])=>node.class_type==="GetVideoComponents"&&link(node.inputs.video,sourceId));
    const size=components&&Object.entries(template).find(([,node])=>node.class_type==="GetImageSize"&&framesOf(template,node.inputs.image,components[0]));
    const vace=Object.values(template).find(node=>node.class_type==="WanVaceToVideo"),video=Object.values(template).find(node=>node.class_type==="CreateVideo");
    if(!sourceId||template[sourceId]?.class_type!=="LoadVideo"||!components||!size||!vace||!video||!sameJson(vace.inputs.width,[size[0],0])||!sameJson(vace.inputs.height,[size[0],1])||!sameJson(vace.inputs.length,[size[0],2])||!sameJson(video.inputs.fps,[components[0],2]))errors.push("Effect dimensions, frame count and FPS must derive from the selected source video");
  }
  if (template && recipe.id === "vace-depth-restyle") {
    const depthInput = recipeInputs.find(input => input.id === "depth_video");
    const depthLoader = graphNodeForInput(template, manifest, "depth_video");
    const depthLoaderId = manifest.inputs.find(input => input.id === "depth_video")?.binding?.node;
    const components = depthLoaderId && Object.entries(template).find(([, node]) => node.class_type === "GetVideoComponents" && link(node.inputs.video, depthLoaderId));
    const vace = Object.values(template).find(node => node.class_type === "WanVaceToVideo");
    if (depthInput?.role !== "preprocessed_depth_control" || depthLoader?.class_type !== "LoadVideo" || !components || !vace || !framesOf(template, vace.inputs.control_video, components[0])) {
      errors.push("Depth recipe must consume its preprocessed depth video directly as VACE control video");
    }
    if (Object.values(template).some(node => /depth/i.test(node.class_type))) errors.push("Depth recipe cannot derive depth inside the workflow");
    if (!recipe.limitations?.some(limit => /does not derive depth/i.test(limit))) errors.push("Depth recipe must state that it does not derive depth");
  }
  return errors;
}

export async function loadEffectRecipeCatalogue(root = new URL("../native-workflows/", import.meta.url)): Promise<EffectRecipeBundle[]> {
  const catalogue: EffectRecipeBundle[] = [];
  for (const folder of (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory())) {
    const directory = new URL(`${folder.name}/`, root);
    let recipeValue: unknown;
    try { recipeValue = JSON.parse(await readFile(new URL("effect-recipe.json", directory), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8")) as CapabilityManifestV2;
    const template = JSON.parse(await readFile(new URL("template.api.json", directory), "utf8")) as ApiGraph;
    const capability = { manifest, template };
    const errors = validateEffectRecipe(recipeValue, capability);
    if (errors.length) throw new Error(`Invalid effect recipe ${folder.name}: ${errors.join("; ")}`);
    catalogue.push({ recipe: recipeValue as EffectRecipe, capability });
  }
  const seen = new Set<string>();
  for (const { recipe } of catalogue) {
    if (seen.has(recipe.id)) throw new Error(`Duplicate effect recipe ${recipe.id}`);
    seen.add(recipe.id);
  }
  return catalogue.sort((left, right) => left.recipe.id.localeCompare(right.recipe.id));
}

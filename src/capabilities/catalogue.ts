import type { CapabilityBundle, CapabilityManifestV2 } from "./types";
import { fromLegacy } from "./legacy";
import type { ApiGraph } from "../workflow/build";
import type { EnhanceManifest, Manifest } from "../workflow/manifest";

const future: Array<[string, string, string, string[], string, string]> = [
  ["camera", "Camera and Cinema", "video", ["VID-02"], "Movement, path, framing, speed and subject lock", "Camera trajectory, depth and pose conditioning"],
  ["storyboard", "Storyboard continuity and transitions", "video", ["VID-03"], "Advanced continuity and transitions (basic team shot ordering and hard-cut assembly are available in Video)", "Reference conditioning and transition subgraphs"],
  ["video-edit", "Edit and extend video", "video", ["VID-05"], "Trim, edit mask, overlap and continuation", "Qualified continuation and video-edit workflows"],
  ["replace-character", "Character replacement", "replacement", ["EDT-01", "EDT-02"], "Available today as Replace character and Copy moves in Change (SCAIL-2)", "Segmentation, tracking, conditioned generation and compositing"],
  ["replace-object", "Object replacement", "replacement", ["EDT-01", "EDT-02"], "Available today as Swap a thing in Change (VACE masked edit with tracked masks)", "Segmentation, tracking, masked editing and compositing"],
  ["replace-environment", "Environment replacement", "replacement", ["EDT-02", "EDT-03"], "Available today as New look in Change, using a mask when only part of the scene should change", "Foreground masks, environment generation and compositing"],
  ["restyle", "Structural style transfer", "motion", ["EDT-04"], "Preset and reference looks are available as New look in Change; depth and pose conditioning are not qualified", "Depth/pose/edge conditioning with a qualified video model"],
  ["relight", "Video relighting", "finishing", ["FIN-01"], "Direction, color, intensity and masks", "Local depth/normal guided relighting and temporal processing"],
  ["inpaint", "Video inpainting", "replacement", ["FIN-02"], "Mask, fill prompt and preservation", "Tracked-mask video inpainting"],
  ["layers", "Layer decomposition", "finishing", ["FIN-02"], "Object selection, alpha and layer order", "Segmentation, depth layers and compositing"],
  ["effects", "Effects library", "finishing", ["FIN-03"], "Effect, timing and intensity", "Versioned open workflow recipes"],
  ["elements", "Reusable Elements", "identity", ["VID-04", "STU-01"], "References, wardrobe, product and environment", "Reference packs and qualified identity conditioning"],
  ["influencer", "Characters", "studios", ["STU-02"], "Characters, scene scripts and storyboard shots", "Reference images, image-to-video shots and storyboard assembly"],
  ["marketing", "Static ads", "studios", ["STU-03"], "Brand kit, product, brief and variants", "Generation, compositing and batch rendering"],
  ["ads", "Ads", "studios", ["STU-03"], "Copy, CTA, product and output format", "Brand templates and variant rendering"],
  ["dubbing", "Dubbing and translation", "audio", ["AUD-01"], "Transcript, language, voice and timing", "Transcription, translation, TTS and alignment"],
  ["sound", "Sound generation", "audio", ["AUD-02"], "Prompt, duration and synchronization", "Qualified local audio model workflow"],
  ["audio-policy", "Audio preservation and mixing", "audio", ["VID-06"], "Preserve, replace, mix, mute and loudness", "Audio extraction, alignment and muxing"],
  ["reconstruct", "Canvas reconstruction", "canvas", ["CNV-01", "CNV-02"], "Selection, masks, layers, outpaint and variations", "Inpainting, segmentation, depth and compositor operations"],
  ["workflow-canvas", "Curated workflow canvas", "canvas", ["CNV-03", "CNV-04"], "Typed task nodes, assets, subgraphs and run state", "Versioned ComfyUI graph compilation and export"],
];

export const plannedCapabilities: CapabilityManifestV2[] = future.map(([id, title, category, tickets, controls, workflow]) => ({
  schemaVersion: 2, id, version: "0.1.0", title, category,
  description: `${controls}. Planned workflow: ${workflow}.`, inputs: [], outputs: [], controls: [], presets: [],
  coverage: { local: "planned", hosted: "planned" }, audioPolicies: [],
  routes: [{ id: "local", execution: "local_comfy", provider: "comfy-local", upstreamProviders: [], implementation: "planned", requirements: [], evidence: ["Workflow has not been implemented or qualified."] }],
  licenses: { software: "Pending implementation", weights: [] }, sources: [], tickets,
}));

/** The workflows a screen shows: every pack that exists, without the planned placeholders (rule 26).
 *  Planned manifests stay in `plannedCapabilities`, so their tickets keep a home. */
export function visibleCapabilities(manifests: CapabilityManifestV2[]): CapabilityManifestV2[] {
  return manifests.filter(manifest => manifest.coverage.local !== "planned");
}

export function buildCatalogue(providers: Array<{ manifest: Manifest | EnhanceManifest; template: ApiGraph; pipeline: string }>): CapabilityBundle[] {
  const bundles = providers.map(p => fromLegacy(p.manifest, p.template, p.pipeline));
  const seen = new Set<string>();
  for (const bundle of bundles) {
    if (seen.has(bundle.manifest.id)) throw new Error(`Duplicate capability: ${bundle.manifest.id}`);
    seen.add(bundle.manifest.id);
  }
  return [...bundles, ...plannedCapabilities.map(manifest => ({ manifest }))];
}


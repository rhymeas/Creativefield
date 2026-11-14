import {capabilitySurface} from "../capabilities/surfaces";
import type {CapabilityManifestV2} from "../capabilities/types";

/** What the user wants to do with a clip/prompt. `auto` asks the router to read it from the inputs. */
export type VideoIntent =
  | "auto"
  | "text-to-video"
  | "image-to-video"
  | "first-last"
  | "character"
  | "motion"
  | "object-swap"
  | "restyle"
  | "effects"
  | "edit";

export type ResolvedVideoIntent = Exclude<VideoIntent, "auto">;

export type VideoRouteResult =
  | {
      ok: true;
      /** The existing manifest to open; its graph is never edited. */
      manifest: CapabilityManifestV2;
      intent: ResolvedVideoIntent;
      /** True when the chosen manifest is a HyperFlow Flash variant. */
      hyperflow: boolean;
      /** Plain words for the details row: why this workflow was chosen. */
      reason: string;
      /** Other ready workflows for the same intent, in preference order. */
      alternatives: CapabilityManifestV2[];
    }
  | {
      ok: false;
      intent: ResolvedVideoIntent;
      /** Plain words for the user: what is missing. */
      reason: string;
    };

const imageRoles = new Set(["start_image", "end_image", "character_image", "style_reference", "reference_image"]);

const isHyperflow = (manifest: CapabilityManifestV2) =>
  /hyperflow/i.test(manifest.title) ||
  (manifest.routes ?? []).some(route =>
    (route.requirements ?? []).some(requirement => requirement.kind === "node" && /hyperflow/i.test(requirement.name)),
  );

const requiredRoles = (manifest: CapabilityManifestV2) =>
  manifest.inputs.filter(input => input.required).map(input => input.id);

const supports = (manifest: CapabilityManifestV2, roles: ReadonlySet<string>) => {
  const required = requiredRoles(manifest);
  if (!required.length) return true;
  return required.every(role => roles.has(role));
};

const imageCount = (roles: ReadonlySet<string>) =>
  [...roles].filter(role => imageRoles.has(role)).length;

/** Read the intent from the attached inputs, unless the user picked one in the Change settings. */
export function videoIntentForRoles(roles: ReadonlySet<string>): ResolvedVideoIntent {
  const has = (role: string) => roles.has(role);
  if (has("character_image")) return has("source_video") ? "character" : "image-to-video";
  if (has("style_reference")) return "restyle";
  if (has("end_image")) return "first-last";
  if (has("start_image")) return "image-to-video";
  if (has("source_video")) return has("mask") || has("edit_mask") ? "edit" : "effects";
  return imageCount(roles) > 0 ? "image-to-video" : "text-to-video";
}

/** Does this manifest belong to the chosen intent? Manifest fields only, no fixed app ids. */
function matchesIntent(manifest: CapabilityManifestV2, intent: ResolvedVideoIntent): boolean {
  const surface = capabilitySurface(manifest);
  const title = manifest.title;
  if (intent === "text-to-video") return surface === "video-create" && !requiredRoles(manifest).some(role => imageRoles.has(role));
  if (intent === "image-to-video") return surface === "video-create" && requiredRoles(manifest).includes("start_image") && !requiredRoles(manifest).includes("end_image");
  if (intent === "first-last") return surface === "video-create" && requiredRoles(manifest).includes("end_image");
  if (intent === "character") return (manifest.category === "motion" || manifest.category === "replacement") && requiredRoles(manifest).includes("character_image");
  if (intent === "motion") {
    const usesMotionModel = (manifest.routes ?? []).some(route =>
      (route.requirements ?? []).some(requirement => requirement.kind === "node" && /animate/i.test(requirement.name)),
    );
    return manifest.category === "motion" && (usesMotionModel || /motion|animate/i.test(title));
  }
  if (intent === "object-swap") return manifest.category === "replacement" && /object|thing|swap|replace/i.test(title) && !requiredRoles(manifest).includes("character_image");
  if (intent === "restyle") return manifest.category === "finishing" && /restyle|style/i.test(title);
  if (intent === "effects") return manifest.category === "finishing" && /effect/i.test(title);
  if (intent === "edit") return surface === "video-edit" || manifest.mediaContract?.kind === "aligned_video_mask_v1";
  return false;
}

/**
 * Pick the existing workflow for an intent. HyperFlow Flash wins whenever a ready HyperFlow
 * template exists; otherwise the ready local workflow is used. Nothing is queued and no graph
 * is changed here: the caller opens the returned manifest.
 */
export function resolveVideoWorkflow(
  catalogue: readonly CapabilityManifestV2[],
  ready: ReadonlySet<string>,
  roles: ReadonlySet<string>,
  requestedIntent: VideoIntent = "auto",
): VideoRouteResult {
  const intent = requestedIntent === "auto" ? videoIntentForRoles(roles) : requestedIntent;
  const candidates = catalogue.filter(manifest =>
    manifest.coverage?.local === "implemented" &&
    matchesIntent(manifest, intent) &&
    supports(manifest, roles),
  );
  const readyCandidates = candidates
    .filter(manifest => ready.has(manifest.id))
    .sort((left, right) => {
      const hyperflow = Number(isHyperflow(right)) - Number(isHyperflow(left));
      return hyperflow || left.title.localeCompare(right.title);
    });
  if (!readyCandidates.length) {
    const known = candidates.length
      ? `Ready workflows for ${intent.replace(/-/g, " ")} are not installed on this computer.`
      : `No workflow matches ${intent.replace(/-/g, " ")} with these inputs.`;
    return {ok: false, intent, reason: known};
  }
  const [manifest, ...rest] = readyCandidates;
  return {
    ok: true,
    manifest,
    intent,
    hyperflow: isHyperflow(manifest),
    reason: isHyperflow(manifest)
      ? `HyperFlow Flash is ready for ${intent.replace(/-/g, " ")}.`
      : `Using the installed ${intent.replace(/-/g, " ")} workflow.`,
    alternatives: rest.slice(0, 4),
  };
}

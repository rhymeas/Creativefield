import type { CapabilityManifestV2, Control, Port, Readiness } from "../capabilities/types";
import { assetMatchesPort } from "../capabilities/assets";
import type { CharacterRecord } from "../team/api";
import type { ElementInputBinding } from "../team/state";

export type ImageDraft = {
  controls: Record<string, string | number | boolean>;
  inputs?: Record<string, string>;
  /** A reference port can take a saved character instead of a project picture. */
  elementInputs?: Record<string, ElementInputBinding>;
  presetId?: string;
};

/** Only reference ports take a saved character; every other image port stays a plain picture. */
export function isCharacterPort(port: Pick<Port, "id" | "type">): boolean {
  return port.type === "image" && port.id.startsWith("reference_image");
}

/** A saved character's first reference as this port's element input; throws a plain reason when it cannot be used. */
export function characterReferenceBinding(record: CharacterRecord, port: Port, projectId: string): ElementInputBinding {
  if (record.projectId !== projectId) throw new Error("Choose a character from this project.");
  const first = [...record.referencePack.references].sort((a, b) => a.ordinal - b.ordinal)[0];
  if (record.referencePack.version !== 1 || !record.elementId || !first || first.ordinal !== 0) throw new Error("This character has no picture to use.");
  if (first.assetMediaType !== "image" || (first.assetProjectId !== null && first.assetProjectId !== projectId)) throw new Error("A character picture belongs to another project.");
  if (!assetMatchesPort({ media_type: first.assetMediaType, content_type: first.assetContentType }, port)) throw new Error("A character picture does not fit this workflow.");
  return { elementId: record.elementId, assetId: first.assetId };
}

const SUPPORTED_IMAGE_CONTROLS = new Set([
  "prompt",
  "negative_prompt",
  "aspect_ratio",
  "resolution",
  "width",
  "height",
  "seed",
  "batch",
  "batch_size",
]);

export function defaultImageDraft(manifest: CapabilityManifestV2): ImageDraft {
  return {
    controls: Object.fromEntries(
      imageControls(manifest)
        .filter((control) => control.default !== undefined)
        .map((control) => [control.id, control.default as string | number | boolean]),
    ),
  };
}

/** Image Studio only renders controls that the selected executable workflow binds. */
export function imageControls(manifest: CapabilityManifestV2): Control[] {
  return manifest.controls.filter(
    (control) => SUPPORTED_IMAGE_CONTROLS.has(control.id) && !!(control.binding || control.apiField) && !control.disabledReason,
  );
}

export function imageDraftIssues(manifest: CapabilityManifestV2, draft: ImageDraft): string[] {
  const issues: string[] = [];
  const preset = draft.presetId ? manifest.presets.find((item) => item.id === draft.presetId) : undefined;
  if (draft.presetId && !preset) issues.push("Choose a supported preset.");
  const presetHasPrompt = typeof preset?.values.prompt === "string" && preset.values.prompt.trim().length > 0;
  for (const port of manifest.inputs) {
    if (port.required && !draft.inputs?.[port.id] && !draft.elementInputs?.[port.id]) issues.push(`${port.label} is required.`);
  }
  for (const control of imageControls(manifest)) {
    const value = draft.controls[control.id];
    if (control.id === "prompt" && (typeof value !== "string" || !value.trim()) && !presetHasPrompt) {
      issues.push("Describe the image before generating.");
      continue;
    }
    if (control.type === "number" || control.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        issues.push(`${control.label} must be a number.`);
        continue;
      }
      if (control.type === "integer" && !Number.isInteger(value)) issues.push(`${control.label} must be a whole number.`);
      if (control.min !== undefined && value < control.min) issues.push(`${control.label} must be at least ${control.min}.`);
      if (control.max !== undefined && value > control.max) issues.push(`${control.label} must be at most ${control.max}.`);
    }
    if (control.type === "select" && control.options?.length && !control.options.includes(value as string | number)) {
      issues.push(`Choose a supported ${control.label.toLowerCase()}.`);
    }
  }
  return [...new Set(issues)];
}

/** The run Image create posts: the draft's project pictures and the saved character on a reference port. */
export function imageRunBody(
  target: { projectId: string; workerId: string; idempotencyKey: string; routeId: string },
  manifest: CapabilityManifestV2,
  draft: ImageDraft,
) {
  return {
    projectId: target.projectId,
    workerId: target.workerId,
    idempotencyKey: target.idempotencyKey,
    capabilityId: manifest.id,
    version: manifest.version,
    routeId: target.routeId,
    inputs: draft.inputs ?? {},
    elementInputs: draft.elementInputs ?? {},
    controls: draft.controls,
    ...(draft.presetId ? { presetId: draft.presetId } : {}),
    audioPolicy: "mute" as const,
  };
}

export function imageGenerateStatus(readiness: Readiness, issues: string[], busy: boolean): { enabled: boolean; text: string } {
  if (busy) return { enabled: false, text: "Generating on local ComfyUI" };
  if (readiness.state !== "ready") return { enabled: false, text: readiness.reasons[0] ?? "This image workflow is not ready." };
  if (issues.length) return { enabled: false, text: issues[0] };
  return { enabled: true, text: "Ready on local ComfyUI" };
}

export function handleImageStudioShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "preventDefault">,
  enabled: boolean,
  generate: () => void,
): boolean {
  if ((!event.ctrlKey && !event.metaKey) || event.key !== "Enter" || !enabled) return false;
  event.preventDefault();
  generate();
  return true;
}

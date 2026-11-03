import type { CapabilityManifestV2, Control, Port, Readiness } from "../capabilities/types";
import { assetMatchesPort } from "../capabilities/assets";
import type { CharacterRecord } from "../team/api";
import type { ElementInputBinding } from "../team/state";
import {characterEditBindings} from "./editor/character-references";

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

/** Add the whole saved reference pack only when it fits without replacing a draft input. */
export function addCharacterReferences(manifest:CapabilityManifestV2,draft:ImageDraft,record:CharacterRecord,projectId:string):ImageDraft {
  const references=Object.values(characterEditBindings(record,manifest,projectId));
  const source=manifest.inputs.find(port=>port.id==="source_image"&&port.type==="image");
  if(!source)throw new Error("The selected workflow cannot use a source image.");
  const inputs={...draft.inputs};
  let referencesForSlots=references;
  if(!inputs[source.id]&&!draft.elementInputs?.[source.id]){
    const first=record.referencePack.references.find(reference=>reference.assetId===references[0].assetId);
    if(!first||!assetMatchesPort({media_type:first.assetMediaType,content_type:first.assetContentType},source))throw new Error("The character picture is incompatible with the source image.");
    inputs[source.id]=first.assetId;
    referencesForSlots=references.slice(1);
    /* A guided edit may require a reference even when the source is the only view. */
    if(references.length===1&&manifest.inputs.some(port=>isCharacterPort(port)&&port.required))referencesForSlots=references;
  }
  const existing=new Set([...Object.entries(draft.inputs??{}).filter(([id])=>id.startsWith("reference_image")).map(([,value])=>value),...Object.values(draft.elementInputs??{}).map(value=>value.assetId)]);
  const missing=referencesForSlots.filter(reference=>!existing.has(reference.assetId));
  const ports=manifest.inputs.filter(port=>isCharacterPort(port)&&!draft.inputs?.[port.id]&&!draft.elementInputs?.[port.id]);
  if(missing.length>ports.length)throw new Error("Not enough empty reference slots. Remove a reference in Image first.");
  const elementInputs={...draft.elementInputs};
  for(const [index,reference] of missing.entries()){
    elementInputs[ports[index].id]=reference;
  }
  return {...draft,inputs,elementInputs};
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

/** Carry the person's prompt and selected pictures into the chosen edit workflow. */
export function imageDraftWithReferences(manifest:CapabilityManifestV2,previous:ImageDraft,inputs:Record<string,string>):ImageDraft {
  const next=defaultImageDraft(manifest);
  return {...next,controls:{...next.controls,prompt:String(previous.controls.prompt??"")},inputs:{...(next.inputs??{}),...inputs}};
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

/** Fibo's prompt enhancer sees only the source, so references need the direct prompt branch. */
export function bypassFiboPromptEnhancer(manifest:CapabilityManifestV2,draft:ImageDraft):boolean {
  return manifest.id==="fibo2-edit"&&manifest.controls.some(control=>control.id==="improve_prompt")&&
    (/@Image\s+[1-4]\b/i.test(String(draft.controls.prompt??""))||["reference_image","reference_image_2","reference_image_3"].some(port=>!!(draft.inputs?.[port]||draft.elementInputs?.[port])));
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
    // Resolve explicit visual references only for the ordered Fibo image ports.
    // Other words and prompts without mentions are sent unchanged.
    controls: manifest.id==="fibo2-edit"
      ? {...draft.controls,...(bypassFiboPromptEnhancer(manifest,draft)?{improve_prompt:false}:{}),...(typeof draft.controls.prompt==="string"?{prompt:draft.controls.prompt.replace(/@Image\s+([1-4])\b/gi,(match,index)=>{const ports=["source_image","reference_image","reference_image_2","reference_image_3"],port=ports[Number(index)-1];return draft.inputs?.[port]||draft.elementInputs?.[port]?`image ${index}`:match;})}:{})}
      : draft.controls,
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

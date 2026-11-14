// Turns ComfyUI's rejection of a prompt into sentences about the studio's own controls.
// ComfyUI reports problems by node ID and input name ("node 56, input image"); the user
// knows them as "Start image". The manifest says which is which.

import type { PromptRejection } from "../comfy/client";
import type { ApiGraph } from "./build";
import type { Manifest } from "./manifest";

export type ExplainedError = { title: string; lines: string[] };

const CONTROL_LABELS: Record<keyof Manifest["inputs"], string> = {
  prompt: "Prompt",
  negative: "Negative prompt",
  start_image: "Start image",
  end_image: "End image",
  motion_video: "Motion video",
  motion_prompt: "Motion description",
  width: "Size",
  height: "Size",
  length: "Duration",
  seed: "Seed",
};

export function explainPromptError(
  rejection: PromptRejection,
  manifest: Manifest,
  template: ApiGraph,
): ExplainedError {
  const labelFor = new Map<string, string>();
  for (const [control, binding] of Object.entries(manifest.inputs) as Array<
    [keyof Manifest["inputs"], Manifest["inputs"][keyof Manifest["inputs"]]]
  >) {
    if (binding && binding.node !== null) labelFor.set(`${binding.node}.${binding.field}`, CONTROL_LABELS[control]);
  }

  const lines: string[] = [];
  for (const [id, nodeError] of Object.entries(rejection.node_errors)) {
    const nodeClass = nodeError.class_type ?? template[id]?.class_type ?? "node";
    for (const err of nodeError.errors) {
      const input = err.extra_info?.input_name ?? "";
      const label = labelFor.get(`${id}.${input}`) ?? `${nodeClass} ${input}`.trim();
      const received = err.extra_info?.received_value;

      if (err.type === "value_not_in_list") {
        const file = manifest.requires?.models.find((m) => m.file === received);
        lines.push(
          file
            ? `The model file "${file.file}" is not installed. It belongs in ComfyUI/models/${file.folder}.`
            : `${label}: "${String(received)}" is not available on this ComfyUI.`,
        );
      } else if (err.type === "required_input_missing") {
        lines.push(`${label} is missing.`);
      } else {
        lines.push(`${label}: ${err.message}${err.details ? ` (${err.details})` : ""}.`);
      }
    }
  }

  if (lines.length === 0) {
    const e = rejection.error;
    lines.push(e?.details ? `${e.message ?? "Rejected"}: ${e.details}` : (e?.message ?? "No further details were given."));
  }
  return { title: "ComfyUI could not start the job", lines: [...new Set(lines)] };
}

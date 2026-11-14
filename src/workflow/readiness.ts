// Can this server run this provider? Compares a provider's template against the node
// definitions ComfyUI reports, so problems show up before Generate instead of as a rejected job.
//
// It checks three things:
//   1. every node class in the template exists on the server
//   2. every dropdown input in the template (model files, sampler names, ...) holds a value
//      the server offers
//   3. inputs the studio controls itself (prompt, image, ...) are skipped, since the studio
//      overwrites them before each job

import type { ApiGraph } from "./build";
import type { InputBinding } from "./manifest";
import type { ObjectInfo } from "./ui-to-api";

/** What the check needs from a provider or an enhancer: its template and the inputs the studio controls. */
export type Checkable = {
  manifest: {
    inputs: Record<string, InputBinding | undefined>;
    requires?: { models: Array<{ folder: string; file: string }> };
  };
  template: ApiGraph;
};

export type ReadinessState =
  | "ready"
  | "missing_models" // node classes are fine, but model files are not installed
  | "incompatible" // a node class or an option is missing; ComfyUI or a node pack needs updating
  | "offline"; // the server could not be asked

export type Readiness = {
  state: ReadinessState;
  missingNodes: string[];
  missingFiles: Array<{ folder: string; file: string }>;
  /** Dropdown values the server does not offer, other than model files. */
  invalidValues: Array<{ node: string; nodeClass: string; input: string; value: string }>;
};

type InputDef = [string | string[], Record<string, unknown>?] | undefined;

/** The options of a dropdown input, or undefined when the input is not a dropdown. */
export function comboOptions(def: InputDef): string[] | undefined {
  if (!def) return undefined;
  if (Array.isArray(def[0])) return def[0];
  if (def[0] === "COMBO" && Array.isArray(def[1]?.options)) return def[1]!.options as string[];
  return undefined;
}

export const OFFLINE: Readiness = { state: "offline", missingNodes: [], missingFiles: [], invalidValues: [] };

export function checkReadiness(provider: Checkable, info: ObjectInfo | null): Readiness {
  if (!info) return OFFLINE;

  const { manifest, template } = provider;
  const studioControlled = new Set(
    Object.values(manifest.inputs)
      .filter((b): b is InputBinding => !!b && b.node !== null)
      .map((b) => `${b.node}.${b.field}`),
  );
  const knownFiles = manifest.requires?.models ?? [];

  const missingNodes = new Set<string>();
  const missingFiles: Readiness["missingFiles"] = [];
  const invalidValues: Readiness["invalidValues"] = [];

  for (const [id, node] of Object.entries(template)) {
    const spec = info[node.class_type];
    if (!spec) {
      missingNodes.add(node.class_type);
      continue;
    }
    for (const [input, value] of Object.entries(node.inputs)) {
      if (typeof value !== "string" || studioControlled.has(`${id}.${input}`)) continue;
      const def = (spec.input.required?.[input] ?? spec.input.optional?.[input]) as InputDef;
      const options = comboOptions(def);
      if (!options || options.includes(value)) continue;

      const known = knownFiles.find((m) => m.file === value);
      if (known) {
        if (!missingFiles.some((f) => f.file === known.file)) missingFiles.push(known);
      } else {
        invalidValues.push({ node: id, nodeClass: node.class_type, input, value });
      }
    }
  }

  const state: ReadinessState =
    missingNodes.size || invalidValues.length ? "incompatible" : missingFiles.length ? "missing_models" : "ready";
  return { state, missingNodes: [...missingNodes], missingFiles, invalidValues };
}

/** One line for each kind of problem, for tooltips and notices. */
export function describeReadiness(r: Readiness): string[] {
  const lines: string[] = [];
  for (const f of r.missingFiles) lines.push(`Missing model file ${f.folder}/${f.file}`);
  for (const n of r.missingNodes) lines.push(`ComfyUI has no node "${n}". Update ComfyUI or install the node pack.`);
  for (const v of r.invalidValues) {
    lines.push(`${v.nodeClass} ${v.input}: "${v.value}" is not offered by this ComfyUI.`);
  }
  return lines;
}

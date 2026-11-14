import type { CapabilityManifestV2 } from "../src/capabilities/types";
import type { ApiGraph } from "../src/workflow/build";
import { INLINE_PREFIX } from "../src/workflow/api-to-ui";

/** The name a feature's graph gets in the node editor; "Apply edits" looks for exactly this saved workflow. */
export const featureFileName = (capabilityId: string) => `ComfyField - ${capabilityId}`;

/**
 * The editor renames a second open copy "… (2)", so the newest saved file of the feature wins:
 * "ComfyField - <id>.json" or "ComfyField - <id> (n).json".
 */
export function newestFeatureFile(capabilityId: string, files: Array<{ path: string; modified?: number }>): string | null {
  const base = featureFileName(capabilityId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${base}(?: \\(\\d+\\))?\\.json$`);
  const matches = files.filter((file) => pattern.test(file.path)).sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
  return matches[0]?.path ?? null;
}

/**
 * Undo the editor's renumbering: node ids from the saved workflow's extra.comfyfield.ids go back to the feature's
 * original ids, links included. Nodes added in the editor keep their own id, prefixed if it would collide.
 */
export function restoreFeatureIds(graph: ApiGraph, ids: Record<string, string> | undefined): ApiGraph {
  if (!ids || !Object.keys(ids).length) return graph;
  const taken = new Set(Object.values(ids)), rename: Record<string, string> = {};
  for (const id of Object.keys(graph)) rename[id] = ids[id] ?? (taken.has(id) ? `n${id}` : id);
  const restored: ApiGraph = {};
  for (const [id, node] of Object.entries(graph)) {
    const inputs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.inputs ?? {})) inputs[key] = Array.isArray(value) && typeof value[0] === "string" && value[0] in rename ? [rename[value[0]], value[1]] : value;
    restored[rename[id]] = { ...node, inputs } as ApiGraph[string];
  }
  // Primitives that only carried a fixed value into a forceInput field go back into that field.
  for (const [id, node] of Object.entries(restored)) {
    if (!id.startsWith(INLINE_PREFIX)) continue;
    const value = (node.inputs as Record<string, unknown>).value;
    for (const consumer of Object.values(restored)) for (const [key, link] of Object.entries(consumer.inputs ?? {})) {
      if (Array.isArray(link) && link[0] === id) (consumer.inputs as Record<string, unknown>)[key] = value;
    }
    delete restored[id];
  }
  return restored;
}

export type FeatureEditCheck = {
  errors: string[];
  changes: { added: string[]; removed: string[]; changed: string[] };
};

/**
 * An edited graph may replace a feature's graph only if everything the feature's own screen binds to is still there:
 * each input and control node with its field, and at least one output node of the original kind.
 */
export function checkFeatureEdit(manifest: CapabilityManifestV2, original: ApiGraph, edited: ApiGraph): FeatureEditCheck {
  const errors: string[] = [];
  const bound = [...manifest.inputs, ...manifest.controls].filter((item) => item.binding);
  for (const item of bound) {
    const { node, field } = item.binding!;
    const target = edited[node];
    if (!target) errors.push(`“${item.label}” is connected to node ${node}, which is missing. Keep that node.`);
    else if (!(field in (target.inputs ?? {}))) errors.push(`“${item.label}” needs the field “${field}” on node ${node} (${target.class_type}).`);
    else if (original[node] && original[node].class_type !== target.class_type) errors.push(`Node ${node} was ${original[node].class_type} and is now ${target.class_type}; “${item.label}” expects the original node.`);
  }
  const outputs = new Set(Object.values(original).map((node) => node.class_type).filter((type) => /^Save|^Preview/.test(type)));
  if (outputs.size && !Object.values(edited).some((node) => outputs.has(node.class_type))) errors.push(`The result node is missing. Keep one of: ${[...outputs].join(", ")}.`);
  const added = Object.keys(edited).filter((id) => !original[id]).map((id) => `${id} ${edited[id].class_type}`);
  const removed = Object.keys(original).filter((id) => !edited[id]).map((id) => `${id} ${original[id].class_type}`);
  const changed = Object.keys(edited).filter((id) => original[id] && JSON.stringify(original[id].inputs) !== JSON.stringify(edited[id].inputs)).map((id) => `${id} ${edited[id].class_type}`);
  return { errors, changes: { added, removed, changed } };
}

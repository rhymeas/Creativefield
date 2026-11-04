import { isDeepStrictEqual } from "node:util";
import type { ApiGraph } from "../src/workflow/build";
import type { CapabilityManifestV2 } from "../src/capabilities/types";
import { assertLocalGraphPolicy, OPENJUTSU_ADVANCED_CLASSES } from "../src/capabilities/policy";
import type { Pool } from "pg";

/** The difference is made against the public graph shown to the editor. Applying it
 * to a freshly compiled graph keeps regenerated uploads and server-only inputs.
 * This only merges edits; callers must validate the edited graph and its media paths
 * before execution. */
export function applyRunGraphEdits(original: ApiGraph, edited: ApiGraph, fresh: ApiGraph): ApiGraph {
  const result = structuredClone(fresh);
  // An added loader may reuse an original run input. Point it at this run's
  // upload too, instead of keeping the old worker filename alive by accident.
  const uploads = new Map<string, string>();
  for (const [id, node] of Object.entries(original)) {
    const current = fresh[id];
    if (!current || current.class_type !== node.class_type) continue;
    for (const [field, before] of Object.entries(node.inputs)) {
      const after = current.inputs[field];
      if (typeof before !== "string" || typeof after !== "string" ||
          !/^comfyfield-[a-zA-Z0-9_.-]+$/.test(before) || !/^comfyfield-[a-zA-Z0-9_.-]+$/.test(after)) continue;
      const prior = uploads.get(before);
      if (prior && prior !== after) throw new Error(`The original upload at ${id}.${field} has more than one replacement`);
      uploads.set(before, after);
    }
  }
  const rebind = (value: unknown) => typeof value === "string" && uploads.has(value) ? uploads.get(value)! : structuredClone(value);
  for (const [id, before] of Object.entries(original)) {
    const after = edited[id];
    const current = result[id];
    if (!current || current.class_type !== before.class_type) {
      throw new Error(`The newly compiled graph no longer matches node ${id}`);
    }
    if (!after) {
      delete result[id];
      continue;
    }
    if (after.class_type !== before.class_type) {
      result[id] = { ...structuredClone(after), inputs: Object.fromEntries(Object.entries(after.inputs).map(([key, value]) => [key, rebind(value)])) };
      continue;
    }
    for (const key of Object.keys(before.inputs)) {
      if (!(key in after.inputs)) delete current.inputs[key];
    }
    for (const [key, value] of Object.entries(after.inputs)) {
      if (!(key in before.inputs) || !isDeepStrictEqual(value, before.inputs[key])) {
        current.inputs[key] = rebind(value);
      }
    }
  }
  for (const [id, node] of Object.entries(edited)) {
    if (id in original) continue;
    if (id in result) throw new Error(`The newly compiled graph already contains node ${id}`);
    result[id] = { ...structuredClone(node), inputs: Object.fromEntries(Object.entries(node.inputs).map(([key, value]) => [key, rebind(value)])) };
  }
  return result;
}

/** Called after inputs are uploaded and compilation is complete, immediately
 * before recording and submitting the graph to the worker. */
export async function applyStoredRunGraphEdits(pool: Pool, workspaceId: string, runId: string, fresh: ApiGraph, manifest: CapabilityManifestV2): Promise<ApiGraph> {
  const row = (await pool.query("SELECT original_graph,edited_graph FROM run_graph_edits WHERE workspace_id=$1 AND run_id=$2", [workspaceId, runId])).rows[0];
  if (!row) return fresh;
  const graph = applyRunGraphEdits(row.original_graph as ApiGraph, row.edited_graph as ApiGraph, fresh);
  assertLocalGraphPolicy(graph, manifest.id === "openjutsu-h3-advanced" ? OPENJUTSU_ADVANCED_CLASSES : undefined);
  return graph;
}

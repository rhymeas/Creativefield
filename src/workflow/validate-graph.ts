// Does this API graph hold up against the node definitions a ComfyUI reports?
// ComfyUI itself runs this check when a prompt is queued; doing it ahead of time, without a
// GPU and without queueing anything, tells a missing node pack from a missing model file.
// Structural problems (a link to a node that is not there) are found even without a server.

import type { ApiGraph } from "./build";
import { comboOptions } from "./readiness";
import type { ObjectInfo } from "./ui-to-api";

export type GraphIssueKind =
  | "bad_link" // a link points at a node id the graph does not have
  | "missing_node" // the node class is not on the server: a node pack is missing or ComfyUI is too old
  | "missing_input" // a required input holds nothing
  | "bad_option" // a dropdown holds a value the server does not offer (usually a model file)
  | "out_of_range" // a number outside the node's own limits
  | "no_output"; // nothing in the graph produces a result

export type GraphIssue = { node: string; nodeClass: string; kind: GraphIssueKind; input?: string; detail: string };

type Spec = [string | string[], Record<string, unknown>?];
const isLink = (value: unknown): value is [string | number, number] =>
  Array.isArray(value) && value.length === 2 && (typeof value[0] === "string" || typeof value[0] === "number") && typeof value[1] === "number";

/**
 * `skip` holds "node.input" pairs the studio fills in before every job (the prompt, the picked
 * image, ...). Their placeholder values are not judged, only that the input exists.
 * Without `info` only the structure is checked.
 */
export function validateGraph(graph: ApiGraph, info: ObjectInfo | null, skip: ReadonlySet<string> = new Set()): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const add = (node: string, kind: GraphIssueKind, detail: string, input?: string) =>
    issues.push({ node, nodeClass: graph[node]?.class_type ?? "?", kind, input, detail });
  let hasOutput = false;

  for (const [id, node] of Object.entries(graph)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (isLink(value) && !graph[String(value[0])]) add(id, "bad_link", `${name} links to node ${value[0]}, which is not in the graph`, name);
    }
    if (!info) continue;
    const def = info[node.class_type];
    if (!def) { add(id, "missing_node", `${node.class_type} is not available on this ComfyUI`); continue; }
    if (def.output_node) hasOutput = true;
    for (const [name, raw] of Object.entries(def.input.required ?? {})) {
      const spec = raw as Spec, value = node.inputs[name];
      /* Dynamic inputs (COMFY_AUTOGROW_V3, COMFY_DYNAMICCOMBO_V3, ...) hold their own value, their
         members as "<name>.<member>" keys, or both; their contents are not judged here. */
      if (typeof spec[0] === "string" && spec[0].startsWith("COMFY_")) {
        const present = (value !== undefined && value !== null) || Object.keys(node.inputs).some(key => key.startsWith(`${name}.`));
        const optional = (spec[1] as { template?: { min?: number }; min?: number } | undefined)?.template?.min === 0;
        if (!present && !optional) add(id, "missing_input", `${name} is required and empty`, name);
        continue;
      }
      if (value === undefined || value === null) { add(id, "missing_input", `${name} is required and empty`, name); continue; }
      if (isLink(value) || skip.has(`${id}.${name}`)) continue;
      const options = comboOptions(spec);
      if (options) {
        if (!options.includes(String(value))) add(id, "bad_option", `${name} is "${String(value)}", which this ComfyUI does not offer`, name);
        continue;
      }
      const limits = spec[1] ?? {}, kind = spec[0];
      if ((kind === "INT" || kind === "FLOAT") && typeof value === "number") {
        const { min, max } = limits as { min?: number; max?: number };
        if ((min !== undefined && value < min) || (max !== undefined && value > max)) add(id, "out_of_range", `${name} is ${value}, outside ${min ?? "-"}..${max ?? "-"}`, name);
      }
    }
  }
  if (info && !hasOutput && Object.values(graph).every(node => info[node.class_type])) add("-", "no_output", "no node in the graph produces a result");
  return issues;
}

/** One line per problem class, so a report says which node packs and which models to look for. */
export function summariseIssues(issues: GraphIssue[]) {
  return {
    nodes: [...new Set(issues.filter(i => i.kind === "missing_node").map(i => i.nodeClass))].sort(),
    options: issues.filter(i => i.kind === "bad_option").map(i => `${i.nodeClass}.${i.input}=${i.detail.match(/"([^"]*)"/)?.[1] ?? ""}`),
    other: issues.filter(i => !["missing_node", "bad_option"].includes(i.kind)),
  };
}

import type { ApiGraph } from "../workflow/build";

/** The upstream graph is pinned to D3voz/openjutsu 7fe118bb. The route remains
 * experimental; the caller must validate worker and model readiness. */
type TitledNode = ApiGraph[string] & { _meta?: { title?: string } };
type TitledGraph = Record<string, TitledNode>;
const isLink = (value: unknown): value is [string, number] => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1]);

function titleId(graph: TitledGraph, title: string, classType: string): string {
  const matches = Object.entries(graph).filter(([, node]) => node._meta?.title === title && node.class_type === classType);
  if (matches.length !== 1) throw new Error(`The advanced workflow must contain one ${title} node.`);
  return matches[0][0];
}

/** Remove unused character branches rather than sending fake placeholder images.
 * Picture names must already be uploaded to the selected ComfyUI worker. */
export function prepareOpenJutsuAdvancedCharacters(source: TitledGraph, filenames: string[], roles: string[] = []): TitledGraph {
  if (!Array.isArray(filenames) || filenames.length < 1 || filenames.length > 4 || filenames.some(name => typeof name !== "string" || !name.trim())) throw new Error("Choose one to four character pictures.");
  if (!Array.isArray(roles) || roles.length > filenames.length || roles.some(role => typeof role !== "string")) throw new Error("Provide at most one role per character.");
  const graph = structuredClone(source);
  const planId = titleId(graph, "Swap Plan (roles, seed, size)", "H3AdvancedSwapPlan");
  const plan = graph[planId];
  const removed = new Set<string>();
  for (let i = 1; i <= 4; i++) {
    const loader = titleId(graph, `Picture ${i}`, "LoadImage");
    const describe = titleId(graph, `Describe picture ${i}`, "TextGenerate");
    const scales = Object.entries(graph).filter(([, node]) => node.class_type === "ImageScaleToMaxDimension" && isLink(node.inputs.image) && node.inputs.image[0] === loader);
    if (scales.length !== 1 || !isLink(graph[describe].inputs.image) || graph[describe].inputs.image[0] !== scales[0][0]) throw new Error(`The advanced workflow picture ${i} branch has changed.`);
    if (i <= filenames.length) graph[loader].inputs.image = filenames[i - 1];
    else for (const id of [loader, scales[0][0], describe]) removed.add(id);
  }
  for (const id of removed) delete graph[id];
  for (const [id, node] of Object.entries(graph)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      if (!isLink(value)) continue;
      if (removed.has(value[0])) {
        const permitted = (id === planId && /^picture_[1-4](?:_text)?$/.test(field)) || (node.class_type === "MiniMaxH3ReferenceToVideo" && /^ref_images\.ref_image_[0-3]$/.test(field));
        if (!permitted) throw new Error(`Unexpected link from ${id}.${field} to removed character branch.`);
        delete node.inputs[field];
      } else if (!graph[value[0]] || value[1] < 0) {
        throw new Error(`Invalid workflow link at ${id}.${field}.`);
      }
    }
  }
  const cleaned = Array.from({ length: filenames.length }, (_, i) => (roles[i] ?? "").replace(/\s+/g, " ").trim());
  const ordinal = ["", "second ", "third ", "fourth "];
  plan.inputs.roles = cleaned.some(Boolean) ? cleaned.map((role, i) => role || (filenames.length === 1 ? "the main person" : `the person with the ${ordinal[i]}most screen time`)).join("\n") : "";
  return graph;
}

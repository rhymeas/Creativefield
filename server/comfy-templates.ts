/*
 * The official Comfy workflow templates (Comfy-Org/workflow_templates), as a list people can browse and import.
 * Only the index and the chosen file are fetched; nothing is installed. The index is kept for an hour.
 */
const ROOT = "https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates";
const INDEX_TTL_MS = 60 * 60 * 1000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;

export type ComfyTemplate = {
  name: string; title: string; description: string; group: string; mediaType: string;
  /** Runs through a Comfy partner API (needs a Comfy account and credits), not only local weights. */
  api: boolean; models: string[]; tags: string[];
  /** The file the importer fetches. */
  url: string;
  thumbnailType: string;
  /** Where Comfy offers it: only "local", only "cloud", or both when empty. */
  runsOn: Array<"local" | "cloud">;
  /** Custom node packs it needs beyond ComfyUI itself. */
  customNodes: string[];
};

type IndexGroup = { title?: string; templates?: Array<{ name?: string; title?: string; description?: string; mediaType?: string; mediaSubtype?: string; tags?: string[]; models?: string[]; includeOnDistributions?: string[]; requiresCustomNodes?: string[] }> };

/** Flattens the template index into one list; entries without a safe name are left out. */
export function flattenTemplateIndex(index: unknown): ComfyTemplate[] {
  if (!Array.isArray(index)) return [];
  return (index as IndexGroup[]).flatMap(group => (group.templates ?? []).flatMap(t => {
    if (!t.name || !NAME.test(t.name)) return [];
    const tags = Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === "string") : [];
    return [{
      name: t.name, title: t.title ?? t.name, description: t.description ?? "", group: group.title ?? "Other",
      mediaType: t.mediaType ?? "image", api: tags.includes("API"), models: Array.isArray(t.models) ? t.models.filter((x): x is string => typeof x === "string") : [], tags,
      url: `${ROOT}/${t.name}.json`, thumbnailType: t.mediaSubtype === "png" || t.mediaSubtype === "jpg" ? t.mediaSubtype : "webp",
      runsOn: Array.isArray(t.includeOnDistributions) ? t.includeOnDistributions.filter((d): d is "local" | "cloud" => d === "local" || d === "cloud") : [],
      customNodes: Array.isArray(t.requiresCustomNodes) ? t.requiresCustomNodes.filter((x): x is string => typeof x === "string") : [],
    }];
  }));
}

let cache: { at: number; list: ComfyTemplate[] } | null = null;
export async function comfyTemplates(fetcher: typeof fetch = fetch): Promise<ComfyTemplate[]> {
  if (cache && Date.now() - cache.at < INDEX_TTL_MS) return cache.list;
  const response = await fetcher(`${ROOT}/index.json`, { signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (!response.ok) throw new Error(`The template index answered ${response.status}`);
  const list = flattenTemplateIndex(await response.json());
  cache = { at: Date.now(), list };
  return list;
}

/** The first preview picture of one template, fetched for the browser so the page never loads foreign images. */
export async function comfyTemplateThumbnail(name: string, fetcher: typeof fetch = fetch): Promise<{ body: Buffer; type: string } | null> {
  const template = (await comfyTemplates(fetcher)).find(t => t.name === name);
  if (!template) return null;
  const response = await fetcher(`${ROOT}/${template.name}-1.${template.thumbnailType}`, { signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (!response.ok) return null;
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 8 * 1024 * 1024) return null;
  return { body, type: template.thumbnailType === "png" ? "image/png" : template.thumbnailType === "jpg" ? "image/jpeg" : "image/webp" };
}

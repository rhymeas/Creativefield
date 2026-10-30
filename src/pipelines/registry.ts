// Provider registry. A provider is a folder under pipelines/<pipeline>/<name>/ holding a
// manifest.json and a template.api.json. Adding a model means adding a folder; no code changes.
//
// Two kinds of folder exist: generation providers (text, image, or first-and-last-frame to video)
// and enhancers (upscaling a finished clip). A manifest says which with `"kind": "enhance"`.
import type { ApiGraph } from "../workflow/build";
import type { EnhanceManifest, Manifest } from "../workflow/manifest";

export type Provider = {
  id: string;
  /** The pipeline folder the provider sits in, e.g. "i2v". */
  pipeline: string;
  /** Project-relative folder, e.g. "pipelines/i2v/wan22-ti2v-5b". Used in install instructions. */
  folder: string;
  manifest: Manifest;
  template: ApiGraph;
};

export type Enhancer = {
  id: string;
  pipeline: "enhance";
  folder: string;
  manifest: EnhanceManifest;
  template: ApiGraph;
};

const manifests = import.meta.glob("../../pipelines/*/*/manifest.json", { eager: true, import: "default" });
const templates = import.meta.glob("../../pipelines/*/*/template.api.json", { eager: true, import: "default" });

type Found = { path: string; manifest: Record<string, unknown>; template: ApiGraph; pipeline: string; folder: string };

function findAll(manifestFiles: Record<string, unknown>, templateFiles: Record<string, unknown>): Found[] {
  return Object.entries(manifestFiles).map(([path, manifest]) => {
    const templatePath = path.replace(/manifest\.json$/, "template.api.json");
    const template = templateFiles[templatePath];
    if (!template) {
      throw new Error(`Provider folder ${path.replace(/manifest\.json$/, "")} has a manifest but no template.api.json`);
    }
    return {
      path,
      manifest: manifest as Record<string, unknown>,
      template: template as ApiGraph,
      pipeline: path.split("/").slice(-3, -2)[0],
      folder: path.replace(/^(\.\.\/)+/, "").replace(/\/manifest\.json$/, ""),
    };
  });
}

/** Generation providers: every folder whose manifest is not an enhancer. */
export function loadProviders(
  manifestFiles: Record<string, unknown> = manifests,
  templateFiles: Record<string, unknown> = templates,
): Provider[] {
  return findAll(manifestFiles, templateFiles)
    .filter((f) => f.manifest.kind !== "enhance")
    .map((f) => ({ id: f.manifest.id as string, pipeline: f.pipeline, folder: f.folder, manifest: f.manifest as unknown as Manifest, template: f.template }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Enhancers: folders whose manifest says `"kind": "enhance"`. */
export function loadEnhancers(
  manifestFiles: Record<string, unknown> = manifests,
  templateFiles: Record<string, unknown> = templates,
): Enhancer[] {
  return findAll(manifestFiles, templateFiles)
    .filter((f) => f.manifest.kind === "enhance")
    .map((f) => ({ id: f.manifest.id as string, pipeline: "enhance" as const, folder: f.folder, manifest: f.manifest as unknown as EnhanceManifest, template: f.template }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export const providers = loadProviders();
export const enhancers = loadEnhancers();

export function providersFor(pipeline: string): Provider[] {
  return providers.filter((p) => p.pipeline === pipeline);
}

import { access, readdir, readFile } from "node:fs/promises";
import { buildCatalogue } from "../src/capabilities/catalogue";
import { validateCapability } from "../src/capabilities/validate";
import {posePreviewWorkflow} from "./pose-preview-workflow";
import {routerBundles} from './providers/comfy-router';
import type { ApiGraph } from "../src/workflow/build";
import type { EnhanceManifest, Manifest } from "../src/workflow/manifest";

/** Where the packs are read from. The defaults are the folders in this repository. */
type CatalogueRoots = { pipelines?: URL; native?: URL; log?: (message: string) => void };

const exists = (url: URL) => access(url).then(() => true, () => false);
const readJson = async (url: URL) => JSON.parse(await readFile(url, "utf8"));
const asFolder = (url: URL) => url.href.endsWith("/") ? url : new URL(`${url.href}/`);

/** The manifest of a pack that sits one folder deeper than the loader reads, if there is one. */
async function nestedPack(dir: URL) {
  const children = (await readdir(dir, { withFileTypes: true })).filter(x => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    const url = new URL(`${child.name}/manifest.json`, dir);
    if (await exists(url)) return { name: child.name, manifest: await readJson(url) };
  }
  return null;
}

/**
 * One native folder: its manifest and template, or null when it is skipped.
 * A skip always says why in the log. A folder that carries a pack declaration the
 * loader cannot use stops startup instead, so a pack never leaves the catalogue quietly.
 */
async function nativePack(name: string, dir: URL, log: (message: string) => void) {
  const manifestUrl = new URL("manifest.json", dir), templateUrl = new URL("template.api.json", dir);
  const [hasManifest, hasTemplate] = await Promise.all([exists(manifestUrl), exists(templateUrl)]);
  if (hasManifest && hasTemplate) return { manifest: await readJson(manifestUrl), template: await readJson(templateUrl) };
  if (hasManifest || hasTemplate) throw new Error(`Incomplete native workflow ${name}: ${hasManifest ? "manifest.json without template.api.json" : "template.api.json without manifest.json"}`);
  const nested = await nestedPack(dir);
  if (!nested) {
    log(`Skipping native-workflows/${name}: no manifest.json or template.api.json`);
    return null;
  }
  if (nested.manifest.comfyuiGraph === false) {
    log(`Skipping native-workflows/${name}: ${nested.name} is not a ComfyUI graph (runtime ${nested.manifest.runtime ?? "none"})`);
    return null;
  }
  const declared = ["kind", "runtime"].filter(key => typeof nested.manifest[key] === "string").map(key => `${key} ${nested.manifest[key]}`);
  throw new Error(`native-workflows/${name} holds ${nested.name}/manifest.json${declared.length ? ` (${declared.join(", ")})` : ""} but no template.api.json, so that pack never reaches the catalogue. Move it to native-workflows/${nested.name}/ with its template, or set "comfyuiGraph": false if it does not run on ComfyUI.`);
}

export async function loadServerCatalogue(options: CatalogueRoots = {}) {
  const log = options.log ?? ((message: string) => console.info(message));
  const providers: Array<{manifest: Manifest | EnhanceManifest; template: ApiGraph; pipeline: string}> = [];
  const root = asFolder(options.pipelines ?? new URL("../pipelines/", import.meta.url));
  for (const pipeline of (await readdir(root, { withFileTypes: true })).filter(x => x.isDirectory())) {
    const dir = new URL(`${pipeline.name}/`, root);
    for (const folder of (await readdir(dir, { withFileTypes: true })).filter(x => x.isDirectory())) {
      const url = new URL(`${folder.name}/`, dir);
      providers.push({ pipeline: pipeline.name, manifest: JSON.parse(await readFile(new URL("manifest.json", url), "utf8")), template: JSON.parse(await readFile(new URL("template.api.json", url), "utf8")) });
    }
  }
  const catalogue = buildCatalogue(providers);
  const nativeRoot = asFolder(options.native ?? new URL("../native-workflows/", import.meta.url));
  for(const folder of (await readdir(nativeRoot,{withFileTypes:true})).filter(x=>x.isDirectory())){
    const native = await nativePack(folder.name, new URL(`${folder.name}/`, nativeRoot), log);
    if (!native) continue;
    const existing=catalogue.findIndex(bundle=>bundle.manifest.id===native.manifest.id);
    if(existing<0)catalogue.push(native);
    else {
      const placeholder=catalogue[existing];
      if(placeholder.template||placeholder.manifest.routes.some(route=>route.implementation!=="planned"))throw new Error(`Duplicate capability ${native.manifest.id}`);
      catalogue[existing]=native;
    }
  }
  catalogue.push(...Array.from({length:6},(_,i)=>posePreviewWorkflow(i+1)));
  catalogue.push(...routerBundles);
  const seen=new Set<string>();
  for (const bundle of catalogue) {
    if(seen.has(bundle.manifest.id))throw new Error(`Duplicate capability ${bundle.manifest.id}`);
    seen.add(bundle.manifest.id);
    const errors = validateCapability(bundle);
    if (errors.length) throw new Error(`Invalid capability ${bundle.manifest.id}: ${errors.join("; ")}`);
  }
  return catalogue;
}

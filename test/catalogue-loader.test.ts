import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadServerCatalogue } from "../server/catalogue";
import speechManifest from "../native-workflows/chatterbox-tts/manifest.json";
import speechTemplate from "../native-workflows/chatterbox-tts/template.api.json";

// The server says which workflow folders it skipped and why, so a pack that the
// loader cannot use never leaves the catalogue quietly.
const scratch: string[] = [];
type Pack = { manifest?: unknown; template?: unknown; nested?: Record<string, unknown> };

async function roots(packs: Record<string, Pack>) {
  const dir = await mkdtemp(join(tmpdir(), "catalogue-loader-"));
  scratch.push(dir);
  await mkdir(join(dir, "pipelines"));
  await mkdir(join(dir, "native-workflows"));
  for (const [name, pack] of Object.entries(packs)) {
    const folder = join(dir, "native-workflows", name);
    await mkdir(folder);
    if (pack.manifest !== undefined) await writeFile(join(folder, "manifest.json"), JSON.stringify(pack.manifest));
    if (pack.template !== undefined) await writeFile(join(folder, "template.api.json"), JSON.stringify(pack.template));
    for (const [child, manifest] of Object.entries(pack.nested ?? {})) {
      await mkdir(join(folder, child));
      await writeFile(join(folder, child, "manifest.json"), JSON.stringify(manifest));
    }
  }
  return { pipelines: pathToFileURL(join(dir, "pipelines") + sep), native: pathToFileURL(join(dir, "native-workflows") + sep) };
}

afterAll(async () => {
  await Promise.all(scratch.map(dir => rm(dir, { recursive: true, force: true })));
});

describe("native workflow loader", () => {
  it("reports malformed native packs and continues only when explicitly requested",async()=>{
    const options=await roots({half:{manifest:{id:'half'}},broken:{manifest:{id:'broken',schemaVersion:2,version:'1'},template:{}},anonymous:{manifest:null,template:{}},speech:{manifest:speechManifest,template:speechTemplate}});
    const problems:Array<{id:string;reason:string}>=[];
    const catalogue=await loadServerCatalogue({...options,log:()=>{},onInvalidNative:(id,reason)=>problems.push({id,reason})});
    expect(catalogue.some(item=>item.manifest.id==='chatterbox-tts')).toBe(true);
    expect(catalogue.some(item=>item.manifest.id==='broken')).toBe(false);
    expect(problems.map(item=>item.id).sort()).toEqual(['anonymous','broken','half']);
    await expect(loadServerCatalogue({...options,log:()=>{}})).rejects.toThrow();
  });
  it("says which folders it skipped and why", async () => {
    const logs: string[] = [];
    const catalogue = await loadServerCatalogue({
      ...await roots({
        marketing: { nested: { "static-ad-v1": { id: "comfyfield-marketing-static-ad", version: "1.0.0", kind: "server-local-compositor", runtime: "sharp-opentype", comfyuiGraph: false } } },
        notes: {},
      }),
      log: message => logs.push(message),
    });
    expect([...logs].sort()).toEqual([
      "Skipping native-workflows/marketing: static-ad-v1 is not a ComfyUI graph (runtime sharp-opentype)",
      "Skipping native-workflows/notes: no manifest.json or template.api.json",
    ]);
    const ids = catalogue.map(bundle => bundle.manifest.id);
    expect(ids).not.toContain("comfyfield-marketing-static-ad");
    expect(ids).toContain("marketing");
  });

  it("stops on a pack that sits one folder too deep", async () => {
    const options = await roots({ "static-ads": { nested: { "static-ad-v1": { id: "static-ad", kind: "server-local-compositor", runtime: "sharp-opentype" } } } });
    await expect(loadServerCatalogue({ ...options, log: () => {} })).rejects.toThrow(
      /native-workflows\/static-ads holds static-ad-v1\/manifest\.json \(kind server-local-compositor, runtime sharp-opentype\) but no template\.api\.json/,
    );
  });

  it("stops on a manifest without a template", async () => {
    const options = await roots({ half: { manifest: { id: "half", version: "1.0.0" } } });
    await expect(loadServerCatalogue({ ...options, log: () => {} })).rejects.toThrow(/Incomplete native workflow half: manifest\.json without template\.api\.json/);
  });

  it("stops on a template without a manifest", async () => {
    const options = await roots({ half: { template: { "1": { class_type: "KSampler" } } } });
    await expect(loadServerCatalogue({ ...options, log: () => {} })).rejects.toThrow(/Incomplete native workflow half: template\.api\.json without manifest\.json/);
  });

  it("loads the shipped tree and names the marketing pack as skipped", async () => {
    const logs: string[] = [];
    const info = vi.spyOn(console, "info").mockImplementation(message => { logs.push(String(message)); });
    try {
      const catalogue = await loadServerCatalogue();
      const ids = catalogue.map(bundle => bundle.manifest.id);
      expect(ids).toContain("chatterbox-tts");
      expect(ids).not.toContain("comfyfield-marketing-static-ad");
    } finally {
      info.mockRestore();
    }
    expect(logs).toContain("Skipping native-workflows/marketing: static-ad-v1 is not a ComfyUI graph (runtime sharp-opentype)");
  });
});

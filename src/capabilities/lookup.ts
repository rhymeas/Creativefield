/// <reference types="vite/client" />
/* One source for a workflow's id and version: the manifest the server loads into the catalogue.
   A version bump in native-workflows/<pack>/manifest.json reaches every screen that queues that
   workflow, instead of leaving a typed-in version behind to fail as "Capability revision unavailable".
   Legacy pipelines keep their version in src/capabilities/legacy.ts, so only native packs are read here. */
import type { CapabilityManifestV2 } from "./types";

/** A workflow as a run asks for it: the id its manifest declares, and that manifest's version. */
export type CapabilityRef = { id: string; version: string };

type ManifestName = Pick<CapabilityManifestV2, "id" | "version" | "controls">;

// Keyed by manifest id, not by folder: camera, lip-sync, video-edit and elements sit in folders of other names.
const manifests = import.meta.glob("../../native-workflows/*/manifest.json", { eager: true, import: "default" }) as Record<string, ManifestName>;
const versions = new Map<string, string>();
for (const manifest of Object.values(manifests)) versions.set(manifest.id, manifest.version);

/** The id and version to send for a workflow. An id no manifest has throws here, at the screen, rather than
 *  as a rejected run. The id stays as written, so a caller keeps the narrow type of the name it passed. */
export function capability<Id extends string>(id: Id): { id: Id; version: string } {
  const version = versions.get(id);
  if (version === undefined) throw new Error(`No workflow manifest has the id ${id}.`);
  return { id, version };
}

/** Only offer a control when the current pack can admit it. */
export function capabilityHasControl(id:string,control:string):boolean {
  return Object.values(manifests).some(manifest=>manifest.id===id&&manifest.controls.some(value=>value.id===control));
}

import type { CapabilityManifestV2, Readiness, Requirement, WorkerInventory } from "./types";
import { assertRoutePolicy } from "./policy";

/** Where a worker's model files live. A local ComfyUI lists them under /models; Comfy Cloud
 *  keeps its own files and has no folder endpoint, so the probe records "cloud" instead. */
export type ProbedInventory = WorkerInventory & { modelInventory?: "worker" | "cloud" };

/** What a person reads when a workflow they picked runs somewhere they did not pick. */
export const CLOUD_ONLY_REASON = "This workflow runs on Comfy Cloud. Pick Comfy Cloud to run it.";

/** What a person reads when the workflow cannot run on the worker they picked at all. */
export const CLOUD_UNAVAILABLE_REASON = "This one needs your own computer. Pick This computer to run it.";

/** The pack's implemented Comfy Cloud route, if it has one. */
export function cloudRoute(manifest: CapabilityManifestV2) {
  return manifest.routes.find(r => r.execution === "comfy_cloud" && r.implementation === "implemented");
}

export function capabilityReadiness(manifest: CapabilityManifestV2, routeId: string, inventory: WorkerInventory): Readiness {
  const route = manifest.routes.find(r => r.id === routeId);
  /* A cloud-only pack has no local route, and the panel asks about the local one first: say where
     the workflow runs instead of calling the missing route unimplemented. */
  if (!route && manifest.routes.some(r => r.execution === "comfy_cloud")) return { state: "unsupported", reasons: [CLOUD_ONLY_REASON], missing: [] };
  if (!route || route.implementation === "planned") return { state: "unsupported", reasons: ["This execution route has not been implemented and qualified."], missing: [] };
  try { assertRoutePolicy(route); } catch { return { state: "incompatible", reasons: ["Execution route violates the independent-provider policy."], missing: [] }; }
  const cloudRoute = route.execution === "comfy_cloud";
  if (route.execution !== "local_comfy" && !cloudRoute) return { state: "unsupported", reasons: ["Hosted execution requires a qualified server adapter; worker inventory and saved credentials do not enable it."], missing: [] };
  /* Comfy Cloud ships its own model files. Its probe reads the files its own node list offers,
     because Cloud has no folder endpoint; a record made before that says nothing about files, so
     models stay unchecked there and Cloud reports a missing file itself. */
  const cloudModels = (inventory as ProbedInventory).modelInventory === "cloud";
  const cloudFiles = cloudModels ? inventory.modelFiles : undefined;
  /* A cloud route runs on the Comfy Cloud worker and nowhere else, so a local worker is not
     something to install on: the answer is to pick the cloud worker. */
  if (cloudRoute && !cloudModels) return { state: "unsupported", reasons: [CLOUD_ONLY_REASON], missing: [] };
  const hasModel = (r: Requirement) => cloudModels
    ? !cloudFiles || cloudFiles.includes(r.name) || inventory.models.includes(r.name) || inventory.models.includes(`${r.location}/${r.name}`)
    : inventory.models.includes(`${r.location}/${r.name}`);
  const missing = route.requirements.filter(r => r.kind === "node" ? !inventory.nodes.includes(r.name)
    : r.kind === "model" ? !hasModel(r)
    : r.kind === "credential" ? !inventory.credentials.includes(r.name) : true);
  if (!inventory.online) return { state: "offline", reasons: ["The selected execution service is not reachable."], missing };
  if(inventory.objectInfoChecked===false)return {state:"incompatible",reasons:["The worker responded without a verified node inventory."],missing};
  const unverifiedFolders=cloudModels?[]:[...new Set(missing.filter(r=>r.kind==="model"&&r.location&&inventory.checkedModelFolders!==undefined&&!inventory.checkedModelFolders.includes(r.location)).map(r=>r.location!))];
  if(unverifiedFolders.length)return {state:"incompatible",reasons:unverifiedFolders.map(folder=>`Model folder ${folder} could not be inventoried; missing files are not confirmed.`),missing};
  if (missing.some(r => r.kind === "credential")) return { state: "credentials_required", reasons: ["Add the selected independent provider credential in workspace settings."], missing };
  /* A file is not something a person installs on Comfy Cloud, and nothing here would bring it: say
     which file Cloud lacks, and name the computer only for a node Cloud does not have. */
  const reasonFor = (r: Requirement) => cloudModels
    ? r.kind === "model" ? `Comfy Cloud does not have ${r.name}.` : `Comfy Cloud does not have ${r.name}. Run this workflow on this computer instead.`
    : r.instructions;
  if (missing.some(r => r.kind === "node" || r.kind === "software")) return { state: "install_required", reasons: missing.map(reasonFor), missing };
  if (missing.length) return cloudModels
    ? { state: "install_required", reasons: missing.map(reasonFor), missing }
    : { state: "download_required", reasons: missing.map(reasonFor), missing };
  if (route.implementation === "experimental") return { state: "unsupported", reasons: ["Experimental workflow has not passed qualification."], missing: [] };
  return { state: "ready", reasons: [], missing: [] };
}

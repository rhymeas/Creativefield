/* A cloud route runs a pack's own graph on Comfy Cloud: the same template, the same run row and
   the same artifacts, but the worker is a Comfy Cloud worker and its probe decides readiness.
   This sits beside the local admission in run-submission.ts because two checks differ: the route
   must be a cloud route, and the worker must be a Comfy Cloud worker. The Comfy Cloud key is read
   from the environment when the run is submitted, never stored on the run. */

import type {PoolClient} from "pg";
import type {CapabilityBundle,CapabilityManifestV2,Invocation,Readiness,RouteDefinition} from "../src/capabilities/types";
import {CLOUD_ONLY_REASON,CLOUD_UNAVAILABLE_REASON,capabilityReadiness,cloudRoute,type ProbedInventory} from "../src/capabilities/readiness";
import {compileLocal} from "../src/capabilities/compile";
import {HttpError} from "./auth";
import {hashToken,newId} from "./crypto";
import {resolveRunInputs} from "./element-inputs";
import {canonical,extension,type PreparedRun,type RunRequest} from "./run-submission";
import {sdkTransportConfigured} from "./sdk-client";

export const CLOUD_WORKER_REASON = CLOUD_ONLY_REASON;

/** What a person reads when a workflow they picked cannot run on the chosen worker at all. */
export { CLOUD_UNAVAILABLE_REASON, cloudRoute };

/** What a person reads when their Comfy Cloud plan will not run anything from another app. */
export const CLOUD_PLAN_BLOCKED_REASON = "Your Comfy Cloud plan does not allow runs from other apps. Upgrade the plan or use a key from a paid account.";

/** What a person reads when this server has no Comfy Cloud key to send the run with. */
export const CLOUD_KEY_REASON = "Comfy Cloud needs its key on this server. Set COMFY_CLOUD_API_KEY or COMFY_CLOUD_API_KEY_FILE.";

/** What the probe learned about the key itself: whether its account may submit a run at all.
 *  A free-tier account authenticates for reads, uploads and the node probe, and Cloud answers
 *  every submitted run with a 403, so no probe of the worker alone could see it. */
export type CloudSubmitAccess = { canSubmit?: boolean; submitBlockedReason?: string };

/** A worker probed longer ago than this is treated as offline, as everywhere else. */
const FRESH_MS = 5 * 60 * 1000;

/** True when this route is the pack's Comfy Cloud route. */
export function isCloudRoute(manifest: CapabilityManifestV2, routeId: string): boolean {
  return manifest.routes.some(route => route.id === routeId && route.execution === "comfy_cloud");
}

/**
 * The route a run takes on Comfy Cloud. A panel names the worker a person picked, and knows the
 * pack's routes only by id: so the route it named is used when it is the cloud route, and the
 * pack's cloud route runs otherwise. The resolved id is frozen on the run like any other.
 */
export function cloudRouteFor(manifest: CapabilityManifestV2, routeId: string): RouteDefinition | undefined {
  return manifest.routes.find(route => route.id === routeId && route.execution === "comfy_cloud" && route.implementation === "implemented") ?? cloudRoute(manifest);
}

/** The inventory a cloud route is judged by; a worker past five minutes counts as offline. */
export function cloudInventory(worker: {inventory?: ProbedInventory & CloudSubmitAccess; checked_at?: string | Date | null}): ProbedInventory & CloudSubmitAccess {
  const inventory = structuredClone((worker.inventory ?? {online: false, nodes: [], models: [], credentials: []}) as ProbedInventory & CloudSubmitAccess);
  if (!worker.checked_at || Date.now() - new Date(worker.checked_at).getTime() > FRESH_MS) inventory.online = false;
  return inventory;
}

/** Readiness for a pack that has a cloud route. A key whose account may not submit leaves every
 *  cloud pack unrunnable, so the answer is the plan in one sentence and not a node list: the nodes
 *  are all there and the run would still be refused. */
export function cloudReadiness(manifest: CapabilityManifestV2, routeId: string, inventory: ProbedInventory & CloudSubmitAccess): Readiness {
  if (manifest.routes.some(route => route.execution === "comfy_cloud") && inventory.canSubmit === false) return {state: "unsupported", reasons: [CLOUD_PLAN_BLOCKED_REASON], missing: []};
  return capabilityReadiness(manifest, routeId, inventory);
}

/** Contracts whose qualified path reads, rewrites or measures a local clip or mask. Comfy Cloud
 *  cannot carry them, so the run is refused in plain words instead of failing after upload. */
const LOCAL_ONLY_CONTRACTS = ["mediaContract", "outputContract", "voiceContract", "motionContract", "editPreservation", "imageArtifacts", "posePreviewContract", "fpsPrepare", "imageInputContract"] as const;

/** Validate and freeze a cloud run before any work is queued, then describe what to submit. */
export async function prepareCloudInvocation(client: PoolClient, catalogue: CapabilityBundle[], workspaceId: string, body: RunRequest): Promise<PreparedRun> {
  if (!(await client.query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2", [workspaceId, body.projectId])).rowCount) throw new HttpError(404, "Project not found");
  const bundle = catalogue.find(candidate => candidate.manifest.id === body.capabilityId);
  if (!bundle) throw new HttpError(404, "Capability not found");
  const route = cloudRouteFor(bundle.manifest, body.routeId);
  if (!bundle.template || !route) throw new HttpError(422, CLOUD_UNAVAILABLE_REASON);
  if (body.tracking !== undefined) throw new HttpError(400, "Tracking input is not supported by this workflow");
  const manifest = bundle.manifest;
  if (LOCAL_ONLY_CONTRACTS.some(key => manifest[key] !== undefined)) throw new HttpError(422, CLOUD_UNAVAILABLE_REASON);
  const worker = (await client.query("SELECT * FROM workers WHERE workspace_id=$1 AND id=$2 AND enabled=true", [workspaceId, body.workerId])).rows[0];
  if (!worker) throw new HttpError(404, "Worker not found");
  if (worker.kind !== "cloud") throw new HttpError(422, CLOUD_WORKER_REASON);
  /* Cloud has no ComfyUI input folder: the inputs go up as Cloud assets on the v2 transport, which
     is the one the key is for. Without it the run could only fail after the upload. */
  if (!sdkTransportConfigured(worker)) throw new HttpError(422, CLOUD_KEY_REASON);
  const readiness = cloudReadiness(manifest, route.id, cloudInventory(worker));
  if (readiness.state !== "ready") throw new HttpError(422, readiness.reasons.join(" "));
  const resolved = await resolveRunInputs(client, manifest, workspaceId, body.projectId, body.inputs, body.elementInputs);
  const inputs = Object.fromEntries(Object.entries(resolved.assets).map(([role, asset]) => [role, `comfyfield-${asset.id}.${extension(asset.content_type)}`]));
  const workflowSha256 = hashToken(canonical(bundle));
  const revision = (await client.query("INSERT INTO workflow_revisions(id,workspace_id,capability_id,version,sha256,manifest,graph) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,capability_id,sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING id", [newId(), workspaceId, body.capabilityId, body.version, workflowSha256, JSON.stringify(manifest), JSON.stringify(bundle.template)])).rows[0].id;
  const controls = {...Object.fromEntries(manifest.controls.filter(control => !control.disabledReason && control.default !== undefined).map(control => [control.id, control.default])), ...body.controls};
  const preset = body.presetId ? manifest.presets.find(candidate => candidate.id === body.presetId) : undefined;
  if (body.presetId && !preset) throw new HttpError(400, "Selected preset is not part of this workflow");
  const invocation: Invocation = {capabilityId: body.capabilityId, version: body.version, routeId: route.id, inputs: resolved.inputIds, controls, audioPolicy: body.audioPolicy, ...(preset ? {presetId: preset.id} : {}), ...(body.consent ? {consent: body.consent} : {})};
  if (Object.keys(resolved.elementInputSnapshots).length) invocation.elementInputSnapshots = resolved.elementInputSnapshots;
  try { compileLocal(bundle, {...invocation, inputs}); } catch (error) { throw new HttpError(400, (error as Error).message); }
  return {projectId: body.projectId, workerId: body.workerId, revisionId: revision, invocation};
}

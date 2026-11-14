import type { Run } from "./api";

/** A fresh run, preserving the original route, inputs and settings. */
export function sharpenRunBody(run: Run, idempotencyKey: string) {
  const invocation = run.invocation;
  if (!invocation || !run.worker_id || !invocation.routeId || !invocation.audioPolicy) throw new Error("The original run settings are unavailable.");
  const inputs = { ...invocation.inputs };
  const elementInputs: Record<string, { elementId: string; assetId: string }> = {};
  for (const [port, snapshot] of Object.entries(invocation.elementInputSnapshots ?? {})) {
    const assetId = inputs[port];
    if (!snapshot || snapshot.inputPort !== port || !snapshot.elementId || !assetId) throw new Error("The original reference is unavailable.");
    elementInputs[port] = { elementId: snapshot.elementId, assetId };
    delete inputs[port];
  }
  return {
    projectId: run.project_id, workerId: run.worker_id, idempotencyKey,
    capabilityId: run.capability_id, version: run.capability_version,
    routeId: invocation.routeId, inputs, elementInputs,
    controls: { ...invocation.controls, sharpen: true }, audioPolicy: invocation.audioPolicy,
    ...(invocation.presetId ? { presetId: invocation.presetId } : {}),
    ...(invocation.consent ? { consent: invocation.consent } : {}),
  };
}

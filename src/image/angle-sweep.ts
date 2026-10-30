/** Angle sweep (F01): two native Fun Camera arcs from one still, frames read back as selectable views. */
export type SweepDirection = "left" | "right";
export const SWEEP_CAPABILITY = { id: "camera", version: "0.2.0" } as const;
/** Camera speed per side: the first real run moved much less to the left than to the right at equal speed. */
export const SWEEP_DIRECTIONS: readonly { id: SweepDirection; label: string; pose: string; speed: number }[] = [
  { id: "left", label: "Left", pose: "Pan Left", speed: 1.6 },
  { id: "right", label: "Right", pose: "Pan Right", speed: 1 },
];
export const SWEEP_FRAMES_PER_SIDE = 4;
const SWEEP_NOTE = "Same subject and scene, the camera moves smoothly sideways with natural parallax, stable and sharp, no new objects.";

export type SweepScope = { workspaceId: string; projectId: string; userId: string; workerId: string };
export type Sweep = { version: 1; id: string; sourceAssetId: string; scope: SweepScope; runIds: Partial<Record<SweepDirection, string>>; pending?: SweepDirection };

export const sweepStorageKey = (scope: SweepScope) => `comfyfield:angle-sweep:${scope.userId}:${scope.workspaceId}:${scope.projectId}`;

export function freezeSweep(sourceAssetId: string, scope: SweepScope, id: string = crypto.randomUUID()): Sweep {
  if (!sourceAssetId || !scope.workerId) throw new Error("Choose a source image and a ready worker.");
  return { version: 1, id, sourceAssetId, scope, runIds: {} };
}

/** Only a saved sweep for the same user, project and source may be resumed. */
export function recoverSweep(value: unknown, scope: SweepScope, sourceAssetId: string): Sweep | null {
  const v = value as Sweep;
  if (!v || v.version !== 1 || !/^[a-f0-9-]{36}$/i.test(v.id) || v.sourceAssetId !== sourceAssetId) return null;
  const s = v.scope;
  if (!s || s.workspaceId !== scope.workspaceId || s.projectId !== scope.projectId || s.userId !== scope.userId) return null;
  return v;
}

export function pendingDirections(sweep: Sweep): SweepDirection[] {
  return SWEEP_DIRECTIONS.map((d) => d.id).filter((id) => !sweep.runIds[id]);
}

export function sweepRunRequest(sweep: Sweep, direction: SweepDirection) {
  const move = SWEEP_DIRECTIONS.find((d) => d.id === direction);
  if (!move) throw new Error("Unknown sweep direction.");
  return {
    projectId: sweep.scope.projectId,
    workerId: sweep.scope.workerId,
    idempotencyKey: `sweep-${sweep.id}-${direction}`,
    capabilityId: SWEEP_CAPABILITY.id,
    version: SWEEP_CAPABILITY.version,
    routeId: "local",
    inputs: { start_image: sweep.sourceAssetId },
    elementInputs: {},
    controls: { prompt: SWEEP_NOTE, camera_pose: move.pose, speed: move.speed, length: 1, width: 640, height: 640, seed: 528 },
    audioPolicy: "mute" as const,
  };
}

/** Evenly spaced capture times, first to last frame of the clip. */
export function sweepFrameTimes(duration: number, count: number): number[] {
  if (!(duration > 0) || count < 1) return [];
  if (count === 1) return [0];
  const last = Math.max(0, duration - 1 / 32);
  return Array.from({ length: count }, (_, i) => (last * i) / (count - 1));
}

/** One strip from far left to far right with the original in the middle (frame 0 of either clip is the original). */
export function sweepOrder<T>(left: T[], original: T, right: T[]): T[] {
  return [...[...left].reverse(), original, ...right];
}

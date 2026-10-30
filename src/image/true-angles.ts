/** True camera angles (F01): a mesh from the source image gives real geometry; each view is rendered from it, then painted to look like the source. */
import { capability } from "../capabilities/lookup";

/** 3D models the true-angle route can build; TRELLIS.2 comes with real surface colors, Hunyuan3D gives shape only. */
export const MESH_CAPABILITIES = [
  { ...capability("trellis2-image-to-3d"), label: "TRELLIS.2 · textured", textured: true },
  { ...capability("hunyuan3d-21"), label: "Hunyuan3D · shape", textured: false },
] as const;
export type MeshCapabilityId = (typeof MESH_CAPABILITIES)[number]["id"];
export const meshCapability = (id: string | undefined) => MESH_CAPABILITIES.find((m) => m.id === id) ?? MESH_CAPABILITIES[0];
export const PAINT_CAPABILITY = capability("qwen-image-21-edit");

/** The same eight slots as the angle sheet, now with exact azimuth/elevation in degrees. Positive azimuth turns the camera to the subject's left. */
export const TRUE_VIEWS = [
  { id: "high-left", label: "High left", azimuth: -40, elevation: 25 },
  { id: "high", label: "High", azimuth: 0, elevation: 35 },
  { id: "high-right", label: "High right", azimuth: 40, elevation: 25 },
  { id: "left-45", label: "Left 45", azimuth: -45, elevation: 0 },
  { id: "right-45", label: "Right 45", azimuth: 45, elevation: 0 },
  { id: "low-left", label: "Low left", azimuth: -40, elevation: -15 },
  { id: "low", label: "Low", azimuth: 0, elevation: -20 },
  { id: "low-right", label: "Low right", azimuth: 40, elevation: -15 },
] as const;
export type TrueViewId = (typeof TRUE_VIEWS)[number]["id"];

/** Camera position on a sphere around the origin, y up, looking at the origin; azimuth 0 is the front (+z). */
export function orbitPosition(azimuth: number, elevation: number, radius: number): [number, number, number] {
  const a = (azimuth * Math.PI) / 180, e = (elevation * Math.PI) / 180;
  return [radius * Math.cos(e) * Math.sin(a), radius * Math.sin(e), radius * Math.cos(e) * Math.cos(a)];
}

export const PAINT_NOTE = "Repaint this gray 3D render so it looks exactly like the subject in the reference photo: same materials, colors, textures, surface details and lighting style. Keep the render's exact shape, outline, viewpoint and framing. Put it in the reference photo's setting, seen from this new angle.";

export type TrueAnglesScope = { workspaceId: string; projectId: string; userId: string; workerId: string };
export type TrueAngles = {
  version: 1; id: string; sourceAssetId: string; scope: TrueAnglesScope;
  /** Which 3D model builds the mesh; older saved states without it used Hunyuan3D. */
  meshCapabilityId?: MeshCapabilityId;
  meshRunId?: string;
  /** Uploaded gray renders, by view. */
  renders: Partial<Record<TrueViewId, string>>;
  /** Painting runs, by view. */
  paintRunIds: Partial<Record<TrueViewId, string>>;
  /** Repaints after a failed or canceled paint, by view; each one gets its own request key. */
  paintAttempts?: Partial<Record<TrueViewId, number>>;
};

export const trueAnglesStorageKey = (scope: TrueAnglesScope) => `comfyfield:true-angles:${scope.userId}:${scope.workspaceId}:${scope.projectId}`;

export function freezeTrueAngles(sourceAssetId: string, scope: TrueAnglesScope, id: string = crypto.randomUUID(), meshCapabilityId: MeshCapabilityId = MESH_CAPABILITIES[0].id): TrueAngles {
  if (!sourceAssetId || !scope.workerId) throw new Error("Choose a source image and a ready worker.");
  return { version: 1, id, sourceAssetId, scope, meshCapabilityId, renders: {}, paintRunIds: {} };
}

export function recoverTrueAngles(value: unknown, scope: TrueAnglesScope, sourceAssetId: string): TrueAngles | null {
  const v = value as TrueAngles;
  if (!v || v.version !== 1 || !/^[a-f0-9-]{36}$/i.test(v.id) || v.sourceAssetId !== sourceAssetId) return null;
  if (v.scope?.workspaceId !== scope.workspaceId || v.scope?.projectId !== scope.projectId || v.scope?.userId !== scope.userId) return null;
  return { ...v, meshCapabilityId: v.meshCapabilityId ?? "hunyuan3d-21", renders: v.renders ?? {}, paintRunIds: v.paintRunIds ?? {} };
}

export function meshRunRequest(state: TrueAngles) {
  return {
    projectId: state.scope.projectId, workerId: state.scope.workerId, idempotencyKey: `true-angles-${state.id}-mesh`,
    capabilityId: meshCapability(state.meshCapabilityId).id, version: meshCapability(state.meshCapabilityId).version, routeId: "local",
    inputs: { start_image: state.sourceAssetId }, elementInputs: {}, controls: {}, audioPolicy: "mute" as const,
  };
}

export function paintRunRequest(state: TrueAngles, view: TrueViewId) {
  const render = state.renders[view];
  if (!render) throw new Error("Render this view before painting it.");
  const attempt = state.paintAttempts?.[view] ?? 0;
  return {
    projectId: state.scope.projectId, workerId: state.scope.workerId, idempotencyKey: `true-angles-${state.id}-paint-${view}${attempt ? `-${attempt}` : ""}`,
    capabilityId: PAINT_CAPABILITY.id, version: PAINT_CAPABILITY.version, routeId: "local",
    inputs: { source_image: render, reference_image: state.sourceAssetId }, elementInputs: {}, controls: { prompt: PAINT_NOTE }, audioPolicy: "mute" as const,
  };
}

/** Views that are rendered and not yet sent for painting, or whose paint failed, in sheet order. */
export function pendingPaints(state: TrueAngles, selected: readonly TrueViewId[], failed: (view: TrueViewId) => boolean = () => false): TrueViewId[] {
  return TRUE_VIEWS.map((v) => v.id).filter((id) => selected.includes(id) && state.renders[id] && (!state.paintRunIds[id] || failed(id)));
}

/** Clears a failed paint and moves the view to its next attempt, so painting it again is a new request. */
export function retryPaint(state: TrueAngles, view: TrueViewId): TrueAngles {
  if (!state.paintRunIds[view]) return state;
  const { [view]: _, ...paintRunIds } = state.paintRunIds;
  return { ...state, paintRunIds, paintAttempts: { ...state.paintAttempts, [view]: (state.paintAttempts?.[view] ?? 0) + 1 } };
}

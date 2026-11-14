/*
 * The merge layer between measured geometry and the StageFlow score plan.
 *
 * The progressive analysis produces three inputs in order: the heuristic plan from
 * the decision batches, then measured `ShotGeometry` batches, then (sometimes) an
 * edited score. This module is the only place that combines them:
 *
 * - `synthesizeMeasuredPlan` builds one `AnalysisPlan` for `planToScoreYaml`: the
 *   measured cast, blocking cues and per-shot cameras where geometry exists, the
 *   heuristic values everywhere else. Impossible measured values are refused and
 *   counted, never written into the plan (no NaN reaches the score).
 * - `mergeGeometryBatch` folds one batch into an existing plan without touching a
 *   shot the person edited (the `edited` status is authoritative).
 *
 * Pure and DOM-free like `score-build.ts`, so the same functions can be tested and
 * reused outside React.
 */
import type {GeometryBatchResult, ShotDecision, ShotGeometry, ShotSkip} from "./analysis-contract";
import {visionPlanFromDecisions} from "./decision";
import {measuredGeometryPlan, type AnalysisPlan, type GeometryRejection, type MeasuredGeometryPlan} from "./score-build";

/** One shot of the analysed clip, in the clip's own time base. */
export type AnalysisShotWindow = {shotIndex: number; startSec: number; endSec: number; label?: string};

/** The spans the score builder needs to pin each measured root at its shot's cut. */
function shotWindows(shots: readonly AnalysisShotWindow[]): Map<number, {startSec: number; endSec: number}> {
  return new Map(shots.map((shot) => [shot.shotIndex, {startSec: shot.startSec, endSec: shot.endSec}]));
}

export type SynthesisInput = {
  /** The plan the decision batches built (heuristic). Empty before the first batch. */
  basePlan?: AnalysisPlan | null;
  /** The decisions that drive the heuristic cameras (all batches so far). */
  decisions?: readonly ShotDecision[];
  /** The measured geometry collected so far. */
  geometries?: readonly ShotGeometry[];
  /** Authoritative shot windows from the scan; index = shot index. */
  shots: readonly AnalysisShotWindow[];
  title?: string;
  aspectRatio?: number;
  /** Shots the person edited: measured values never replace their camera or blocking. */
  editedShotIndices?: readonly number[];
  /** The clip's cut list, when the callers wants the heuristic plan mapped to segments. */
  cuts?: readonly number[];
};

export type SynthesisReport = {
  /** Shot indices that received a measured camera. */
  measuredShotIndices: number[];
  measuredCount: number;
  rejected: GeometryRejection[];
  rejectedCount: number;
  entityCount: number;
  blockingCount: number;
  /** Measured height per entity, in metres (the Geometry module shows it). */
  heights: Array<{id: string; label: string; heightM: number}>;
};

export type SynthesisResult = {plan: AnalysisPlan; report: SynthesisReport};

const DEFAULT_CAMERA = {target: "actor-a", maneuver: "dolly", distance: 5.5, pitch: 10, yaw: 0, lens: 35} as const;

/** Camera the heuristic uses for a shot the decisions did not describe (same numbers as the score builder). */
function fallbackCamera(index: number, characterId: string): Record<string, unknown> {
  return index === 0
    ? {...DEFAULT_CAMERA, target: characterId}
    : {target: characterId, maneuver: "cut", distance: 3.2, pitch: 10, yaw: 0, lens: 50};
}

/** The heuristic plan from the decision batches: one shot per scan shot, in shot order. */
export function heuristicPlan(decisions: readonly ShotDecision[], shots: readonly AnalysisShotWindow[], title: string): AnalysisPlan {
  const windows = [...shots].sort((left, right) => left.shotIndex - right.shotIndex);
  const known = new Set(windows.map((shot) => shot.shotIndex));
  const decided = [...decisions].filter((decision) => known.has(decision.shotIndex)).sort((left, right) => left.shotIndex - right.shotIndex);
  const decisionPlan = decided.length ? visionPlanFromDecisions(decided.map((decision) => ({index: decision.shotIndex, decision})), title) : null;
  const characters = (decisionPlan?.entities ?? []).filter((entity) => entity.kind === "character" && typeof entity.id === "string");
  const characterId = characters[0]?.id ?? "actor-a";
  const byIndex = new Map<number, NonNullable<AnalysisPlan["shots"]>[number]>();
  for (const [order, decision] of decided.entries()) {
    const shot = decisionPlan?.shots?.[order];
    if (shot) byIndex.set(decision.shotIndex, shot);
  }
  return {
    title,
    premise: decisionPlan?.premise ?? "Blockout from the detected cuts; measured geometry is refining it.",
    stage: {width: 12, depth: 10},
    ...(decisionPlan?.entities?.length ? {entities: decisionPlan.entities} : {}),
    shots: windows.map((window, index) => {
      const decidedShot = byIndex.get(window.shotIndex);
      return {
        label: decidedShot?.label ?? window.label ?? `Shot ${index + 1}`,
        start: window.startSec,
        end: window.endSec,
        camera: decidedShot?.camera ?? fallbackCamera(index, characterId),
      };
    }),
  };
}

/** Enough plan shape to write a readable score when nothing else exists yet. */
function basePlanFor(input: SynthesisInput): AnalysisPlan {
  return input.basePlan ?? heuristicPlan(input.decisions ?? [], input.shots, input.title ?? "Reference analysis");
}

/** The camera a slot falls back to when no measurement exists for it. */
function heuristicCameraFor(plan: AnalysisPlan, slot: number, characterId: string): Record<string, unknown> {
  const explicit = plan.shots?.[slot]?.camera;
  return explicit ?? fallbackCamera(slot, characterId);
}

function characterIdOf(plan: AnalysisPlan): string {
  return plan.entities?.find((entity) => entity.kind === "character" && typeof entity.id === "string")?.id ?? "actor-a";
}

function reportOf(measured: MeasuredGeometryPlan, entities: number, blocking: number): SynthesisReport {
  return {
    measuredShotIndices: measured.measuredShotIndices,
    measuredCount: measured.measuredShotIndices.length,
    rejected: measured.rejections,
    rejectedCount: measured.rejections.length,
    entityCount: entities,
    blockingCount: blocking,
    heights: [...measured.heights.entries()].map(([id, heightM]) => ({id, label: id, heightM})),
  };
}

/** The quality of one geometry: older cache rows carry no field and are measured. */
export function geometryQualityOf(geometry: ShotGeometry): "measured" | "estimated" {
  return geometry.quality === "estimated" ? "estimated" : "measured";
}

export type GeometryCoverage = {measured: number[]; estimated: number[]; skipped: number[]};

/**
 * Classify the analysed shots for the one summary line: a shot is measured, estimated or
 * skipped, never two of them. A cached geometry always wins over a stale skip entry for the
 * same shot, so the counts cannot overlap.
 */
export function geometryCoverage(input: {geometries: readonly ShotGeometry[]; skips: readonly ShotSkip[]}): GeometryCoverage {
  const measured = new Set<number>();
  const estimated = new Set<number>();
  for (const geometry of input.geometries) {
    if (geometryQualityOf(geometry) === "estimated") estimated.add(geometry.shotIndex);
    else measured.add(geometry.shotIndex);
  }
  const sorted = (values: Set<number>) => [...values].sort((left, right) => left - right);
  const skipped = sorted(new Set(input.skips.map((skip) => skip.shotIndex))).filter((shotIndex) => !measured.has(shotIndex) && !estimated.has(shotIndex));
  return {measured: sorted(measured), estimated: sorted(estimated), skipped};
}

export type GeometryTargetPlan = {
  /** Shot indices the studio may request from the geometry stage. */
  targets: number[];
};

/**
 * Which shots the geometry stage should measure: every shot that is not already measured,
 * edited or cached as a confirmed skip. The decision pass does NOT filter here: a d3
 * `people_count` of 0 is not authoritative, so the shot is still requested and the server
 * confirms the skip itself (SAM3 keyframe check) with the reason it returns.
 */
export function geometryTargetShots(input: {
  shotCount: number;
  /** The collected decisions; deliberately unused for filtering (kept so the call site reads clearly). */
  decisions?: readonly ShotDecision[];
  measuredShotIndices?: readonly number[];
  editedShotIndices?: readonly number[];
  skippedShotIndices?: readonly number[];
}): GeometryTargetPlan {
  const measured = new Set(input.measuredShotIndices ?? []);
  const edited = new Set(input.editedShotIndices ?? []);
  const skipped = new Set(input.skippedShotIndices ?? []);
  const targets: number[] = [];
  for (let shotIndex = 0; shotIndex < Math.max(0, Math.floor(input.shotCount)); shotIndex++) {
    if (measured.has(shotIndex) || edited.has(shotIndex) || skipped.has(shotIndex)) continue;
    targets.push(shotIndex);
  }
  return {targets};
}

/** One per-shot error of a geometry batch, classified for the studio. */
export type GeometryBatchOutcome = {
  /** Server-confirmed skips: the shot stays blockout and is never retried by a later scan. */
  skips: ShotSkip[];
  /** The short reason shown on the shot (a skip reason or a failure message). */
  notes: Record<number, string>;
  /** Failures that are not a decision to keep the blockout; they get the one stage Notice. */
  failures: Array<{shotIndex: number; message: string}>;
};

/**
 * The server's per-shot error messages that are decisions to keep the blockout, not
 * failures: a floor that is not usable and a person root that could not be localized
 * (the SAM3 keyframe pass found no person / no usable foot point).
 */
export function isConfirmedSkipReason(message: string): boolean {
  // Confirmed skips the server produces: no usable floor, no person root, the SAM3 keyframe
  // confirmation ("no usable person mask") and its explicit "skipped after SAM3 confirmation".
  return /no usable floor|no person|no usable person mask|skipped after SAM3 confirmation/i.test(message);
}

/**
 * Split a geometry batch's per-shot errors into confirmed skips (persisted, quiet note)
 * and real failures (retried next run, one Notice). The server decides the skip; the
 * client only classifies the sentence it sent back.
 */
export function classifyGeometryBatch(result: Pick<GeometryBatchResult, "errors">): GeometryBatchOutcome {
  const skips: ShotSkip[] = [];
  const notes: Record<number, string> = {};
  const failures: Array<{shotIndex: number; message: string}> = [];
  for (const error of result.errors ?? []) {
    notes[error.shotIndex] = error.message;
    if (isConfirmedSkipReason(error.message)) skips.push({shotIndex: error.shotIndex, reason: error.message});
    else failures.push({shotIndex: error.shotIndex, message: error.message});
  }
  return {skips, notes, failures};
}

/**
 * Combine the heuristic plan and every measured geometry batch collected so far
 * into the plan `planToScoreYaml` writes. Edited shots never change.
 */
export function synthesizeMeasuredPlan(input: SynthesisInput): SynthesisResult {
  const plan = basePlanFor(input);
  const aspectRatio = input.aspectRatio ?? 16 / 9;
  const edited = new Set(input.editedShotIndices ?? []);
  const measured = measuredGeometryPlan(
    {
      geometries: input.geometries ?? [],
      skipShotIndices: [...edited],
      slotFor: (geometry: ShotGeometry) => geometry.shotIndex,
    },
    {aspectRatio, slotCount: input.shots.length, windows: shotWindows(input.shots)},
  );
  const baseEntities = plan.entities ?? [];
  const measuredBodies = measured.entities;
  const entities = measuredBodies.length ? [...measuredBodies, ...baseEntities.filter((entity) => entity.kind !== "character")].slice(0, 8) : baseEntities;
  const characterId = measuredBodies[0]?.id ?? characterIdOf(plan);
  const shots = input.shots
    .slice()
    .sort((left, right) => left.shotIndex - right.shotIndex)
    .map((window, index) => {
      const baseShot = plan.shots?.[window.shotIndex] ?? plan.shots?.[index];
      const camera = measured.cameras.get(window.shotIndex);
      return {
        label: baseShot?.label ?? window.label ?? `Shot ${index + 1}`,
        start: window.startSec,
        end: window.endSec,
        camera: camera
          ? {target: camera.target, maneuver: camera.maneuver, distance: camera.distance, pitch: camera.pitch, yaw: camera.yaw, lens: camera.lens}
          : heuristicCameraFor(plan, window.shotIndex, characterId),
      };
    });
  const merged: AnalysisPlan = {
    ...plan,
    // Measured positions are camera-relative metres: the score builder must not clamp them to the diorama.
    measured: measured.entities.length > 0 || measured.cameras.size > 0,
    duration: input.shots.length ? Math.max(...input.shots.map((shot) => shot.endSec)) : plan.duration,
    entities,
    shots,
    blocking: measured.blocking.length ? measured.blocking.map((cue) => ({...cue})) : plan.blocking,
  };
  return {plan: merged, report: reportOf(measured, entities.length, merged.blocking?.length ?? 0)};
}

/** Last measured floor position of an entity in a plan, from its blocking cues or its start position. */
function lastPosition(plan: AnalysisPlan, id: string): number[] | null {
  const cues = (plan.blocking ?? []).filter((cue) => cue.entity === id && Array.isArray(cue.position)).sort((left, right) => (left.start ?? 0) - (right.start ?? 0));
  const cue = cues[cues.length - 1];
  if (cue?.position) return cue.position;
  const entity = plan.entities?.find((entry) => entry.id === id);
  return entity?.position ?? null;
}

function freeEntityId(plan: AnalysisPlan, measured: MeasuredGeometryPlan): string {
  const used = new Set((plan.entities ?? []).map((entity) => entity.id));
  for (let index = 0; index < 26; index++) {
    const candidate = `person-${String.fromCharCode(97 + index)}`;
    if (!used.has(candidate) && !measured.heights.has(candidate)) return candidate;
  }
  return `person-${(plan.entities?.length ?? 0) + 1}`;
}

export type GeometryBatchMerge = {
  plan: AnalysisPlan;
  report: SynthesisReport;
  /** Shot indices the batch really changed (measured, not edited). */
  updatedShotIndices: number[];
};

/**
 * Fold one measured geometry batch into an existing plan. The batch's cast is
 * matched to the plan's entities by the last measured floor position, so the
 * person keeps one id across batches; an edited shot keeps its plan values.
 */
export function mergeGeometryBatch(
  plan: AnalysisPlan,
  batch: readonly ShotGeometry[],
  options: {shots: readonly AnalysisShotWindow[]; aspectRatio?: number; editedShotIndices?: readonly number[]},
): GeometryBatchMerge {
  const aspectRatio = options.aspectRatio ?? 16 / 9;
  const edited = new Set(options.editedShotIndices ?? []);
  const measured = measuredGeometryPlan(
    {geometries: batch, skipShotIndices: [...edited], slotFor: (geometry: ShotGeometry) => geometry.shotIndex},
    {aspectRatio, slotCount: options.shots.length, windows: shotWindows(options.shots)},
  );
  // A measured cast replaces the heuristic characters (the decisions invented them);
  // props and marks from the plan stay, and an already-measured plan keeps its cast.
  const entities = plan.measured ? [...(plan.entities ?? [])] : (plan.entities ?? []).filter((entity) => entity.kind !== "character");
  const remap = new Map<string, string>();
  for (const measuredEntity of measured.entities) {
    const position = measuredEntity.position;
    let match: (typeof entities)[number] | null = null;
    let matchDistance = Number.POSITIVE_INFINITY;
    for (const entity of entities) {
      if (entity.kind !== "character" || typeof entity.id !== "string") continue;
      const last = lastPosition(plan, entity.id);
      if (!last) continue;
      const distance = Math.hypot(last[0] - position[0], last[2] - position[2]);
      if (distance < matchDistance && distance <= 3.5) {
        matchDistance = distance;
        match = entity;
      }
    }
    if (match && typeof match.id === "string") {
      remap.set(measuredEntity.id, match.id);
      // A later measurement corrects the cast height, never the person.
      match.height = measuredEntity.height;
      match.rotation = measuredEntity.rotation;
    } else {
      const id = entities.some((entity) => entity.id === measuredEntity.id) ? freeEntityId({...plan, entities}, measured) : measuredEntity.id;
      remap.set(measuredEntity.id, id);
      entities.push({...measuredEntity, id, label: id === measuredEntity.id ? measuredEntity.label : `Person ${id.slice(-1).toUpperCase()}`});
    }
  }
  // A re-measured shot replaces its old cues instead of stacking a second set on top (two
  // overlapping pin cues would fight over the root). Only entities of this batch are touched.
  const remappedIds = new Set([...remap.values()]);
  const repairedWindows = (batch ?? [])
    .map((geometry) => options.shots.find((shot) => shot.shotIndex === geometry.shotIndex))
    .filter((shot): shot is AnalysisShotWindow => !!shot)
    .map((shot) => ({startSec: shot.startSec, endSec: shot.endSec}));
  const blocking = [...(plan.blocking ?? [])].filter((cue) => {
    const entity = typeof cue.entity === "string" ? remap.get(cue.entity) ?? cue.entity : "";
    if (!remappedIds.has(entity)) return true;
    const cueStart = cue.start ?? 0;
    const cueEnd = cue.end ?? cueStart;
    return !repairedWindows.some((window) => cueStart < window.endSec && cueEnd > window.startSec);
  });
  for (const cue of measured.blocking) {
    const entity = remap.get(cue.entity);
    if (!entity) continue;
    blocking.push({...cue, entity});
  }
  blocking.sort((left, right) => (left.start ?? 0) - (right.start ?? 0) || String(left.entity).localeCompare(String(right.entity)));
  const characterId = entities.find((entity) => entity.kind === "character" && typeof entity.id === "string")?.id ?? "actor-a";
  const shots = [...(plan.shots ?? [])];
  const updatedShotIndices: number[] = [];
  for (const [slot, camera] of measured.cameras) {
    if (edited.has(slot)) continue;
    const window = options.shots.find((shot) => shot.shotIndex === slot);
    const previous = shots[slot];
    const baseShot = previous ?? {
      label: window?.label ?? `Shot ${slot + 1}`,
      start: window?.startSec ?? 0,
      end: window?.endSec ?? 0,
      camera: fallbackCamera(slot, characterId),
    };
    shots[slot] = {...baseShot, camera: {target: camera.target, maneuver: camera.maneuver, distance: camera.distance, pitch: camera.pitch, yaw: camera.yaw, lens: camera.lens}};
    if (window) {
      shots[slot].start = window.startSec;
      shots[slot].end = window.endSec;
    }
    updatedShotIndices.push(slot);
  }
  const merged: AnalysisPlan = {...plan, measured: true, entities, shots, ...(blocking.length ? {blocking} : {})};
  return {
    plan: merged,
    updatedShotIndices: updatedShotIndices.sort((left, right) => left - right),
    report: reportOf(measured, entities.length, blocking.length),
  };
}

/*
 * The pure score builder: a scene plan (and, optionally, measured geometry)
 * becomes a StageFlow-style YAML score the studio can open directly.
 *
 * This module is deliberately free of DOM and Node APIs: the browser bundle and
 * the team server both import it, so the server can build the same cut-only
 * blockout for first paint that the studio builds. `analysis.ts` keeps the
 * browser sampling helpers and re-exports everything here, so existing imports
 * did not move.
 *
 * Measured geometry input (`ScorePlanOptions.geometry`) replaces the heuristic
 * values with measurements, per shot and per person:
 * - entities come from the measured person tracks (stable ids across shots,
 *   heights clamped to a plausible human range),
 * - blocking cues interpolate the person keyframes across shots (the score's
 *   decoupled blocking timeline, with a cut wherever the shot changes),
 * - each measured shot gets a camera cue that reproduces the measured framing:
 *   the camera sits at eye = (0, heightM, 0) and looks at the measured subject,
 *   exactly the convention documented in `analysis-contract.ts`.
 * Every shot without geometry keeps the heuristic camera the plan described.
 */
import {lensMmFromHorizontalFov, SENSOR_WIDTH_MM, type GeometryCamera, type PersonTrack, type ShotGeometry} from "./analysis-contract";

export type AnalysisPlan = {
  title?: string;
  premise?: string;
  duration?: number;
  stage?: {width?: number; depth?: number};
  /**
   * True when this plan carries measured geometry: its entity and blocking positions are
   * camera-relative metres, so they are not clamped to the diorama stage.
   */
  measured?: boolean;
  entities?: Array<{id?: string; label?: string; kind?: string; position?: number[]; rotation?: number; height?: number; color?: string}>;
  shots?: Array<{label?: string; start?: number; end?: number; camera?: Record<string, unknown>}>;
  blocking?: Array<{entity?: string; start?: number; end?: number; from?: number[]; position?: number[]; lookAt?: string; look_at?: string; visible?: boolean; easing?: string; cut?: boolean}>;
};

export type ScorePlanOptions = {
  videoUrl?: string;
  titleHint?: string;
  aspectRatio?: number;
  durationSec?: number;
  /** Hard cut times detected in the uploaded clip; they win over model-estimated shot times. */
  cuts?: number[];
  /** Segment index of each model shot when the frames came from selected shots (triage). */
  analyzedShotIndices?: number[];
  /** Measured geometry; when present it replaces the heuristic entities, blocking and per-shot cameras. */
  geometry?: GeometryScoreInput;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const number = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.trim() : fallback);
export const COLORS = ["#38bdf8", "#f59e0b", "#f472b6", "#a3e635", "#e879f9"];
const ENTITY_ID = /^[A-Za-z0-9_-]+$/;

export const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "reference-scene";
export const yamlString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
export const vector = (values: number[]) => `[${values.map((value) => Math.round(value * 100) / 100).join(", ")}]`;

/** One canonical cut list for triage, shot cards and the score builder. */
export function normalizeCuts(rawCuts: number[] | undefined, durationSec: number): number[] {
  const end = Math.max(0.2, durationSec || 0);
  const normalized: number[] = [];
  for (const cut of [...(rawCuts ?? [])].sort((left, right) => left - right)) {
    const time = Math.round(cut * 100) / 100;
    if (time <= 0.2 || time >= end - 0.2 || normalized.length >= 59) continue;
    const previous = normalized[normalized.length - 1];
    if (previous !== undefined && time - previous < 0.15) continue;
    normalized.push(time);
  }
  return normalized;
}

/* ── Measured geometry: pure conversions shared by the studio and the merge layer ─────────── */

/** The measured person height the heuristic assumes; also the fallback for a broken track. */
export const DEFAULT_PERSON_HEIGHT_M = 1.75;

/** A measured height outside this range is not a person: it is clamped, never written raw. */
export const PERSON_HEIGHT_RANGE_M: readonly [number, number] = [1.2, 2.1];

/** Measured positions outside the stage-adjacent world are not usable camera-relative metres. */
const MAX_WORLD_M = 60;
/** Two measured tracks are the same person when their floor positions stay this close across a cut. */
const TRACK_MATCH_RADIUS_M = 3.5;
/** Score camera limits, identical to the heuristic path in this file. The minimum matches the
 *  score parser's own floor so an extreme close-up face measurement is not pushed away. */
const CAMERA_DISTANCE_M: readonly [number, number] = [0.4, 40];
const CAMERA_LENS_MM: readonly [number, number] = [12, 200];
const CAMERA_PITCH_DEG: readonly [number, number] = [-85, 85];
/** How far ahead of the measured eye an environment shot (no person) aims, in metres. */
const ENVIRONMENT_TARGET_M = 4;

/** One measured value the score refuses: it is counted and the heuristic value stays. */
export type GeometryRejection = {shotIndex: number; field: string; value?: number; reason: string};

export type MeasuredShotCamera = {
  /** Score target: the primary measured subject (or the centroid) as a world point. */
  target: number[];
  maneuver: "cut";
  distance: number;
  pitch: number;
  yaw: number;
  lens: number;
};

export type MeasuredEntity = {
  id: string;
  label: string;
  kind: "character";
  position: number[];
  rotation: number;
  height: number;
  color: string;
};

export type MeasuredBlockingCue = {entity: string; start: number; end: number; from: number[]; position: number[]; lookAt?: string; visible?: boolean; cut: boolean; easing: string};

export type GeometryScoreInput = {
  /** One geometry result per measured shot. */
  geometries: readonly ShotGeometry[];
  /** Segment index of each geometry when only selected shots were measured (triage). */
  shotIndices?: readonly number[];
  /** Shots the person edited: their camera and blocking stay exactly as they are. */
  skipShotIndices?: readonly number[];
  /** Map a geometry result onto its slot in the emitted shot list (default: its own shotIndex). */
  slotFor?: (geometry: ShotGeometry, order: number) => number;
};

export type MeasuredGeometryPlan = {
  entities: MeasuredEntity[];
  blocking: MeasuredBlockingCue[];
  /** Score camera per emitted shot slot. */
  cameras: Map<number, MeasuredShotCamera>;
  /** Emitted slots that got a measured camera. */
  measuredShotIndices: number[];
  /** Measured height per entity id (the Geometry module shows it). */
  heights: Map<string, number>;
  /** Impossible values that were dropped instead of written into the score. */
  rejections: GeometryRejection[];
};

/** Height written into the score: a plausible human range, with the heuristic as fallback. */
export function measuredHeightM(raw: unknown, rejections?: GeometryRejection[], shotIndex = -1): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    rejections?.push({shotIndex, field: "person.heightM", value: typeof raw === "number" ? raw : undefined, reason: "The measured height is not a number; 1.75 m is used."});
    return DEFAULT_PERSON_HEIGHT_M;
  }
  return clamp(raw, PERSON_HEIGHT_RANGE_M[0], PERSON_HEIGHT_RANGE_M[1]);
}

/** Vertical field of view the evaluator will use for a lens at this aspect ratio. */
export function verticalFovFromLens(lensMm: number, aspectRatio: number): number {
  const sensorHeight = SENSOR_WIDTH_MM / Math.max(0.01, aspectRatio);
  return (2 * Math.atan(sensorHeight / (2 * Math.max(1, lensMm))) * 180) / Math.PI;
}

/** The lens the evaluator needs to see this vertical FOV; the measured lens is only a fallback. */
function lensForCamera(camera: GeometryCamera, rejections: GeometryRejection[], shotIndex: number): number | null {
  const measured = number(camera.lensMm, NaN);
  const horizontal = number(camera.fovDeg, NaN);
  const lens = Number.isFinite(measured) ? measured : Number.isFinite(horizontal) ? lensMmFromHorizontalFov(horizontal) : null;
  if (lens === null || !Number.isFinite(lens) || lens <= 0) {
    rejections.push({shotIndex, field: "camera.fovDeg", value: horizontal, reason: "The measured field of view is not usable; the heuristic camera stays."});
    return null;
  }
  return clamp(lens, CAMERA_LENS_MM[0], CAMERA_LENS_MM[1]);
}

type SanitizedTrack = {heightM: number; keyframes: Array<{timeSec: number; xM: number; zM: number}>};

/** Keep only finite, plausible measurements; count every value that was refused. */
function sanitizePersons(persons: readonly PersonTrack[], shotIndex: number, rejections: GeometryRejection[]): SanitizedTrack[] {
  const tracks: SanitizedTrack[] = [];
  for (const person of persons ?? []) {
    const heightM = measuredHeightM(person?.heightM, rejections, shotIndex);
    const keyframes: SanitizedTrack["keyframes"] = [];
    for (const frame of person?.keyframes ?? []) {
      const timeSec = number(frame?.timeSec, NaN);
      const xM = number(frame?.xM, NaN);
      const zM = number(frame?.zM, NaN);
      if (![timeSec, xM, zM].every(Number.isFinite) || timeSec < 0) {
        rejections.push({shotIndex, field: "person.keyframe", value: timeSec, reason: "A measured person position is not a number and was skipped."});
        continue;
      }
      if (Math.abs(xM) > MAX_WORLD_M || Math.abs(zM) > MAX_WORLD_M) {
        rejections.push({shotIndex, field: "person.keyframe", value: Math.max(Math.abs(xM), Math.abs(zM)), reason: "A measured person position is outside the stage world and was skipped."});
        continue;
      }
      keyframes.push({timeSec, xM, zM});
    }
    keyframes.sort((left, right) => left.timeSec - right.timeSec);
    if (keyframes.length) tracks.push({heightM, keyframes});
  }
  return tracks;
}

/** The two keyframes that bound one measured shot: first and last of its primary track. */
function firstKeyframe(track: SanitizedTrack) {
  return track.keyframes[0];
}

type TrackAccumulator = {
  key: number;
  heightM: number;
  /** Every keyframe with the slot it was measured in; the blocking timeline is built from this. */
  keyframes: Array<{slot: number; timeSec: number; xM: number; zM: number}>;
};

/**
 * Match measured tracks across shots into one cast. Geometry reports per-shot ids
 * ("person-1".."person-N"); the person is identified by a greedy nearest-position match
 * against that person's position in an EARLIER shot. Two tracks of the same shot are never
 * matched to the same entity (two SAM3 masks stay two figures), and a track only continues
 * an entity that already has a keyframe before this shot, so roots never jump backwards.
 */
function matchTracks(shots: Array<{slot: number; tracks: SanitizedTrack[]}>): TrackAccumulator[] {
  const accumulators: TrackAccumulator[] = [];
  for (const shot of shots) {
    const usedInShot = new Set<number>();
    for (const track of shot.tracks) {
      const first = firstKeyframe(track);
      if (!first) continue;
      let best: TrackAccumulator | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const candidate of accumulators) {
        if (usedInShot.has(candidate.key)) continue;
        const last = candidate.keyframes[candidate.keyframes.length - 1];
        // Only an earlier shot can continue the entity; an entity already seen in this shot is taken.
        if (!last || last.slot >= shot.slot || last.timeSec > first.timeSec + 0.001) continue;
        const distance = Math.hypot(last.xM - first.xM, last.zM - first.zM);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
      const target = best && bestDistance <= TRACK_MATCH_RADIUS_M ? best : null;
      if (target) {
        usedInShot.add(target.key);
        target.keyframes.push({slot: shot.slot, ...first});
        for (const frame of track.keyframes.slice(1)) target.keyframes.push({slot: shot.slot, ...frame});
        // The cast height is the latest measurement; a track corrected by the person wins.
        target.heightM = track.heightM;
      } else {
        accumulators.push({key: accumulators.length, heightM: track.heightM, keyframes: track.keyframes.map((frame) => ({slot: shot.slot, ...frame}))});
      }
    }
  }
  return accumulators;
}

/** The score target for one measured shot: primary subject, centroid, or the stage centre. */
function measuredCamera(camera: GeometryCamera, persons: readonly SanitizedTrack[], _aspectRatio: number, shotIndex: number, rejections: GeometryRejection[]): MeasuredShotCamera | null {
  const heightM = number(camera?.heightM, NaN);
  if (!Number.isFinite(heightM) || heightM <= 0.1 || heightM > 6) {
    rejections.push({shotIndex, field: "camera.heightM", value: Number.isFinite(heightM) ? heightM : undefined, reason: "The measured camera height is not usable; the heuristic camera stays."});
    return null;
  }
  const lens = lensForCamera(camera, rejections, shotIndex);
  if (lens === null) return null;
  // The reference camera is reproduced as it stood: the measured eye at (0, heightM, 0), the
  // measured pitch, looking straight ahead (+z, the analysis frame's view axis). It is NOT aimed at
  // the people: aiming recentres every figure and, from a high eye, always looks down - a person on
  // the right of a low-angle shot would come out centred under a high angle (2026-11-13).
  const pitchDeg = clamp(number(camera?.pitchDeg, 0), CAMERA_PITCH_DEG[0], CAMERA_PITCH_DEG[1]);
  const pitchRad = (pitchDeg * Math.PI) / 180;
  const usable = persons.filter((person) => firstKeyframe(person));
  // The look-at point sits on the view axis at the people's depth (focus and orbit pivot), or a
  // fixed distance ahead for a shot without people (an environment shot,).
  const depth = usable.length
    ? usable.reduce((total, person) => total + Math.max(0.3, firstKeyframe(person).zM) / usable.length, 0)
    : ENVIRONMENT_TARGET_M;
  const distance = clamp(depth / Math.max(0.2, Math.cos(pitchRad)), CAMERA_DISTANCE_M[0], CAMERA_DISTANCE_M[1]);
  const target: [number, number, number] = [0, heightM - distance * Math.sin(pitchRad), distance * Math.cos(pitchRad)];
  return {
    target,
    maneuver: "cut",
    distance,
    pitch: pitchDeg,
    yaw: clamp((Math.atan2(-target[0], -target[2]) * 180) / Math.PI, -360, 360),
    lens,
  };
}

/**
 * Turn measured per-shot geometry into the three score ingredients: the cast, the
 * blocking cues from the person keyframes, and a camera per shot. Every measured shot
 * pins each figure to its own root (a cut at the shot start), so a person with a single
 * keyframe still stands where the mask was measured instead of drifting in from a
 * neighbouring shot. Every impossible value is refused and counted; the heuristic stays.
 */
export function measuredGeometryPlan(
  input: GeometryScoreInput,
  options: {aspectRatio?: number; slotCount?: number; windows?: ReadonlyMap<number, {startSec: number; endSec: number}>} = {},
): MeasuredGeometryPlan {
  const aspectRatio = clamp(number(options.aspectRatio, 16 / 9), 0.2, 4);
  const rejections: GeometryRejection[] = [];
  const skip = new Set(input.skipShotIndices ?? []);
  const slotFor = input.slotFor ?? ((geometry: ShotGeometry) => geometry.shotIndex);
  const sorted = [...(input.geometries ?? [])]
    .map((geometry, order) => ({geometry, order, slot: slotFor(geometry, order)}))
    .filter((entry) => Number.isFinite(entry.slot) && entry.slot >= 0)
    .filter((entry) => options.slotCount === undefined || entry.slot < options.slotCount)
    .sort((left, right) => {
      const leftTime = left.geometry.persons?.[0]?.keyframes?.[0]?.timeSec ?? Number.POSITIVE_INFINITY;
      const rightTime = right.geometry.persons?.[0]?.keyframes?.[0]?.timeSec ?? Number.POSITIVE_INFINITY;
      return leftTime - rightTime || left.geometry.shotIndex - right.geometry.shotIndex;
    });
  const shots: Array<{slot: number; tracks: SanitizedTrack[]}> = [];
  const cameras = new Map<number, MeasuredShotCamera>();
  for (const {geometry, slot} of sorted) {
    const tracks = sanitizePersons(geometry.persons ?? [], geometry.shotIndex, rejections);
    if (tracks.length) shots.push({slot, tracks});
    if (skip.has(slot)) continue;
    const camera = measuredCamera(geometry.camera, tracks, aspectRatio, geometry.shotIndex, rejections);
    if (camera) cameras.set(slot, camera);
  }
  // Every measured shot in time order (a background-only shot counts too: it hides the cast that
  // is not in it), with the real shot span when the caller knows it.
  const measuredSlots = [...new Set(sorted.map((entry) => entry.slot))].sort((left, right) => left - right);
  const slotWindow = new Map<number, {startSec: number; endSec: number}>();
  for (const slot of measuredSlots) {
    const tracks = shots.find((shot) => shot.slot === slot)?.tracks ?? [];
    const times = tracks.flatMap((track) => track.keyframes.map((frame) => frame.timeSec));
    const given = options.windows?.get(slot);
    // A background-only shot has no keyframe to fall back on: without a window it cannot be placed.
    if (!times.length && !given) continue;
    const startSec = given?.startSec ?? Math.min(...times);
    const endSec = Math.max(given?.endSec ?? Math.max(...times), startSec + 0.2);
    slotWindow.set(slot, {startSec, endSec});
  }
  const accumulators = matchTracks(shots);
  const entities: MeasuredEntity[] = [];
  const heights = new Map<string, number>();
  const blocking: MeasuredBlockingCue[] = [];
  for (const accumulator of accumulators) {
    if (entities.length >= 8) break;
    const id = `person-${String.fromCharCode(97 + entities.length)}`;
    const label = entities.length === 0 ? "Person" : `Person ${String.fromCharCode(65 + entities.length)}`;
    const first = accumulator.keyframes[0];
    const heightM = clamp(accumulator.heightM, PERSON_HEIGHT_RANGE_M[0], PERSON_HEIGHT_RANGE_M[1]);
    entities.push({id, label, kind: "character", position: [first.xM, 0, first.zM], rotation: 0, height: heightM, color: COLORS[entities.length % COLORS.length]});
    heights.set(id, heightM);
    const bySlot = new Map<number, Array<{slot: number; timeSec: number; xM: number; zM: number}>>();
    for (const frame of accumulator.keyframes) {
      const list = bySlot.get(frame.slot) ?? [];
      list.push(frame);
      bySlot.set(frame.slot, list);
    }
    // One cue per measured shot: the shot's own root pins the figure at the cut.
    for (const slot of measuredSlots) {
      const window = slotWindow.get(slot);
      if (!window || skip.has(slot)) continue;
      const frames = (bySlot.get(slot) ?? []).slice().sort((left, right) => left.timeSec - right.timeSec);
      if (!frames.length) {
        // This measured shot has no mask for the person: hide the figure at the cut instead of
        // letting it drift in from the previous shot at the wrong scale.
        const previous = accumulator.keyframes.filter((frame) => frame.slot < slot && !skip.has(frame.slot));
        const anchor = previous[previous.length - 1] ?? first;
        blocking.push({
          entity: id,
          start: window.startSec,
          end: window.endSec,
          from: [anchor.xM, 0, anchor.zM],
          position: [anchor.xM, 0, anchor.zM],
          visible: false,
          cut: true,
          easing: "linear",
        });
        continue;
      }
      const head = frames[0];
      const tail = frames[frames.length - 1];
      // Pin the shot start to the first measured root; the cut makes the root authoritative.
      if (window.startSec < head.timeSec - 0.001) {
        blocking.push({entity: id, start: window.startSec, end: head.timeSec, from: [head.xM, 0, head.zM], position: [head.xM, 0, head.zM], visible: true, cut: true, easing: "linear"});
      }
      // The measured movements inside the shot stay interpolated.
      for (let index = 0; index < frames.length - 1; index++) {
        const from = frames[index];
        const to = frames[index + 1];
        if (to.timeSec - from.timeSec < 0.05) continue;
        blocking.push({entity: id, start: from.timeSec, end: to.timeSec, from: [from.xM, 0, from.zM], position: [to.xM, 0, to.zM], visible: true, cut: false, easing: "linear"});
      }
      // Pin the shot end to the last measured root, so the root holds until the cut.
      if (window.endSec > tail.timeSec + 0.001) {
        blocking.push({entity: id, start: tail.timeSec, end: window.endSec, from: [tail.xM, 0, tail.zM], position: [tail.xM, 0, tail.zM], visible: true, cut: false, easing: "linear"});
      }
      if (blocking.length >= 400) break;
    }
    if (blocking.length >= 400) break;
  }
  blocking.sort((left, right) => left.start - right.start || left.entity.localeCompare(right.entity));
  return {entities, blocking, cameras, measuredShotIndices: [...cameras.keys()].sort((left, right) => left - right), heights, rejections};
}

/**
 * Normalize a plan into the fields the score format needs, and emit it as YAML.
 * With `options.geometry` the measured cast, blocking and cameras replace the
 * heuristic ones per shot; a shot without geometry keeps the heuristic camera.
 */
export function planToScoreYaml(plan: AnalysisPlan, options: ScorePlanOptions = {}): {yaml: string; entities: number; shots: number} {
  const declaredDuration = options.durationSec ?? number(plan.duration, NaN);
  const duration = clamp(Number.isFinite(declaredDuration) ? declaredDuration : 0, 0, 3600);
  const stageWidth = clamp(number(plan.stage?.width, 12), 4, 40);
  const stageDepth = clamp(number(plan.stage?.depth, 12), 4, 40);
  const aspectRatio = clamp(number(options.aspectRatio, 16 / 9), 0.2, 4);
  // Real cut times detected in the clip are authoritative; keep them consistent with triage.
  const clipEnd = options.durationSec ?? duration;
  const detectedCuts = normalizeCuts(options.cuts, clipEnd);
  const segments = detectedCuts.length
    ? (() => {
        const bounds = [0, ...detectedCuts, clipEnd];
        return bounds.slice(1).map((stop, index) => ({start: bounds[index], end: stop}));
      })()
    : [];
  // Entities first: shots and blocking reference their ids. A measured plan keeps the
  // camera-relative metres it was written with; a heuristic plan is clamped to the stage.
  const measuredBounds = plan.measured === true || !!options.geometry;
  const boundX = measuredBounds ? MAX_WORLD_M : stageWidth / 2 - 0.5;
  const boundZ = measuredBounds ? MAX_WORLD_M : stageDepth / 2 - 0.5;
  const baseEntities: Array<{id: string; label: string; kind: "character" | "prop" | "marker"; position: number[]; rotation: number; height: number; color: string}> = [];
  {
    const seen = new Set<string>();
    for (const [index, raw] of (plan.entities ?? []).entries()) {
      if (baseEntities.length >= 5) break;
      const position = Array.isArray(raw.position) ? raw.position : [];
      const candidate = text(raw.id, `actor-${String.fromCharCode(97 + index)}`);
      const id = ENTITY_ID.test(candidate) && !seen.has(candidate) ? candidate : `actor-${String.fromCharCode(97 + index)}`;
      seen.add(id);
      const kind = raw.kind === "prop" || raw.kind === "marker" ? raw.kind : "character";
      baseEntities.push({
        id,
        label: text(raw.label, kind === "character" ? `Actor ${String.fromCharCode(65 + index)}` : id),
        kind,
        position: [clamp(number(position[0], 0), -boundX, boundX), 0, clamp(number(position[2], 0), -boundZ, boundZ)],
        rotation: clamp(number(raw.rotation, 0), -360, 360),
        height: kind === "character" ? clamp(number(raw.height, 1.75), 1.2, 2.1) : clamp(number(raw.height, 0.9), 0.1, 4),
        color: /^#[0-9a-fA-F]{6}$/.test(text(raw.color, "")) ? text(raw.color, COLORS[index % COLORS.length]) : COLORS[index % COLORS.length],
      });
    }
  }
  // The measured geometry needs the shot spans so every measured root can be pinned at the cut.
  const rawPlanShots = (plan.shots ?? []).slice(0, 128);
  const slotWindows = new Map<number, {startSec: number; endSec: number}>();
  if (segments.length) {
    segments.forEach((segment, index) => slotWindows.set(index, {startSec: segment.start, endSec: segment.end}));
  } else {
    rawPlanShots.forEach((shot, index) => {
      const start = clamp(number(shot.start, (index / Math.max(1, rawPlanShots.length)) * duration), 0, 3600);
      slotWindows.set(index, {startSec: start, endSec: clamp(number(shot.end, start + 3), start + 0.2, 3600)});
    });
  }
  // Measured geometry: it wins over the heuristic cast and per-shot cameras where it exists.
  // The slot map of the emitted shot list decides which measured camera belongs to which shot.
  const geometrySlotFor: NonNullable<GeometryScoreInput["slotFor"]> = (geometry, order) => (segments.length || options.cuts?.length ? geometry.shotIndex : order);
  const measured = options.geometry
    ? measuredGeometryPlan(
        {...options.geometry, slotFor: options.geometry.slotFor ?? geometrySlotFor},
        {aspectRatio, slotCount: (segments.length || Math.max(1, rawPlanShots.length)), windows: slotWindows},
      )
    : null;
  const measuredPersons = measured?.entities ?? [];
  const entities = measuredPersons.length
    ? [...measuredPersons, ...baseEntities.filter((entity) => entity.kind !== "character")].slice(0, 8)
    : baseEntities;
  if (!entities.length) {
    entities.push({id: "actor-a", label: "Actor A", kind: "character", position: [0, 0, 0], rotation: 0, height: 1.75, color: COLORS[0]});
  }
  const seen = new Set(entities.map((entity) => entity.id));
  const characterIds = entities.filter((entity) => entity.kind === "character").map((entity) => entity.id);
  // Shot list: with real cuts the plan describes each detected shot in order; otherwise it brings its own times.
  // A measured flow can carry the whole shot list (up to the 60-cut detection limit), not the 16 a model plan had.
  const rawShots = (plan.shots ?? []).slice(0, 128);
  const specs = segments.length
    ? (() => {
        // Triage sends frames for selected shots only; map each model shot to its segment.
        const modeled = new Map<number, (typeof rawShots)[number]>();
        rawShots.forEach((shot, index) => {
          const target = options.analyzedShotIndices?.[index] ?? index;
          if (target >= 0 && target < segments.length) modeled.set(target, shot);
        });
        return segments.map((segment, index) => ({...(modeled.get(index) ?? {}), start: segment.start, end: segment.end}));
      })()
    : rawShots.map((shot, index) => {
        const start = clamp(number(shot.start, (index / Math.max(1, rawShots.length)) * duration), 0, 3600);
        return {...shot, start, end: clamp(number(shot.end, start + 3), start + 0.2, 3600)};
      });
  const shots = specs
    .map((shot, index) => {
      const start = number(shot.start, 0);
      const end = Math.max(start + 0.2, number(shot.end, start + 3));
      const camera = shot.camera ?? {};
      // A measured shot replaces the heuristic camera with the measured one; the rest keep it.
      const measuredCamera = measured?.cameras.get(index);
      // The score target stays a string (entity id) or a raw vector; the emitter below distinguishes them.
      const rawTarget = measuredCamera ? measuredCamera.target : shot.camera?.target;
      const target: string | number[] = measuredCamera
        ? measuredCamera.target
        : typeof rawTarget === "string" && seen.has(rawTarget)
          ? rawTarget
          : Array.isArray(rawTarget) && rawTarget.length >= 3
            ? [number(rawTarget[0], 0), number(rawTarget[1], 1.2), number(rawTarget[2], 0)]
            : (characterIds[0] ?? [0, 1.1, 0]);
      const maneuver = measuredCamera ? measuredCamera.maneuver : ["cut", "dolly", "arc", "orbit", "sweep", "spiral", "swoop", "dive", "recoil", "spline"].includes(String(camera.maneuver)) ? String(camera.maneuver) : index === 0 ? "dolly" : "cut";
      const distance = measuredCamera ? measuredCamera.distance : clamp(number(camera.distance, 4), 0.6, 40);
      return {
        label: text(shot.label, `Shot ${index + 1}`),
        start,
        end,
        camera: {
          target,
          maneuver,
          distance,
          distanceStart: maneuver === "dolly" ? Math.min(40, distance * 1.35) : undefined,
          pitch: measuredCamera ? measuredCamera.pitch : clamp(number(camera.pitch, 10), -85, 85),
          yaw: measuredCamera ? measuredCamera.yaw : clamp(number(camera.yaw, 0), -360, 360),
          lens: measuredCamera ? measuredCamera.lens : clamp(number(camera.lens, 35), 12, 200),
        },
      };
    })
    .sort((left, right) => left.start - right.start);
  if (!shots.length) {
    const fallback = duration || 12;
    for (let index = 0; index < 3; index++) {
      const start = (fallback / 3) * index;
      shots.push({label: `Shot ${index + 1}`, start, end: start + fallback / 3, camera: {target: characterIds[0] ?? [0, 1.1, 0], maneuver: index === 0 ? "dolly" : "cut", distance: index === 0 ? 5.5 : 3.2, distanceStart: index === 0 ? 7 : undefined, pitch: 10, yaw: 0, lens: index === 0 ? 35 : 50}});
    }
  }
  const totalDuration = Math.max(duration, shots[shots.length - 1].end, 2);
  const lines: string[] = [
    "# Scene reconstructed from a reference by the studio's analysis.",
    'version: "1.0"',
    `id: ${yamlString(`analysis-${slug(plan.title ?? options.titleHint ?? "reference-scene")}`)}`,
    `title: ${yamlString(text(plan.title, options.titleHint ? `Reconstruction: ${options.titleHint}` : "Reconstruction"))}`,
    ...(plan.premise ? [`description: ${yamlString(plan.premise)}`] : []),
    ...(options.videoUrl ? [`video: ${yamlString(options.videoUrl)}`] : []),
    `aspect_ratio: ${Number(aspectRatio.toFixed(3))}`,
    `duration: ${Number(totalDuration.toFixed(2))}`,
    "stage:",
    `  width: ${stageWidth}`,
    `  depth: ${stageDepth}`,
    "  grid_step: 1",
    "  observer_camera: { target: [0, 1.1, 0], distance: 10, pitch: 26, yaw: 35, lens: 35mm }",
    "entities:",
    ...entities.map((entity) => `  - { id: ${yamlString(entity.id)}, label: ${yamlString(entity.label)}, kind: ${yamlString(entity.kind)}, position: ${vector(entity.position)}, rotation: ${entity.rotation}, height: ${entity.height}, color: ${yamlString(entity.color)} }`),
    "shots:",
    ...shots.map((shot, index) => [
      `  - id: ${yamlString(`shot-${index + 1}`)}`,
      `    label: ${yamlString(shot.label)}`,
      `    start: ${Number(shot.start.toFixed(2))}`,
      `    end: ${Number(shot.end.toFixed(2))}`,
      `    stage_camera: { target: ${typeof shot.camera.target === "string" ? yamlString(shot.camera.target) : vector(shot.camera.target)}, maneuver: ${yamlString(shot.camera.maneuver)}, distance: ${Number(shot.camera.distance.toFixed(2))}${shot.camera.distanceStart ? `, distance_start: ${Number(shot.camera.distanceStart.toFixed(2))}` : ""}, pitch: ${Number(shot.camera.pitch.toFixed(1))}, yaw: ${Number(shot.camera.yaw.toFixed(1))}, lens: ${Number(shot.camera.lens.toFixed(0))}mm }`,
    ].join("\n")),
  ];
  // Measured blocking cues are the measured data; a heuristic plan keeps the model's small cue list.
  // A measured plan may carry pin/hide cues for every measured shot and person (few hundred).
  const cueLimit = measured?.blocking.length ? 400 : plan.measured ? 400 : 12;
  const blocking: Array<{entity: string; start: number; end: number; from?: number[]; position: number[]; lookAt?: string; visible?: boolean; easing?: string; cut: boolean}> = measured?.blocking.length
    ? measured.blocking.map((cue) => ({...cue, lookAt: cue.lookAt}))
    : (plan.blocking ?? [])
        .filter((cue) => typeof cue.entity === "string" && seen.has(cue.entity))
        .slice(0, cueLimit)
        .map((cue) => {
          const position = Array.isArray(cue.position) ? cue.position : [0, 0, 0];
          const from = Array.isArray(cue.from) ? cue.from : undefined;
          const start = clamp(number(cue.start, 0), 0, totalDuration);
          const end = clamp(number(cue.end, start + 3), start + 0.2, totalDuration);
          const lookAt = typeof cue.lookAt === "string" ? cue.lookAt : typeof cue.look_at === "string" ? cue.look_at : undefined;
          return {
            entity: String(cue.entity),
            start,
            end,
            from: from ? [clamp(number(from[0], 0), -60, 60), 0, clamp(number(from[2], 0), -60, 60)] : undefined,
            position: [clamp(number(position[0], 0), -60, 60), 0, clamp(number(position[2], 0), -60, 60)] as number[],
            lookAt: lookAt && seen.has(lookAt) ? lookAt : undefined,
            visible: cue.visible === false ? false : cue.visible === true ? true : undefined,
            easing: typeof cue.easing === "string" ? cue.easing : undefined,
            cut: cue.cut === true,
          };
        });
  if (blocking.length) {
    lines.push(
      "blocking:",
      ...blocking.map((cue, index) =>
        `  - { id: ${yamlString(`cue-${index + 1}`)}, entity: ${yamlString(cue.entity)}, start: ${Number(cue.start.toFixed(2))}, end: ${Number(cue.end.toFixed(2))}${cue.from ? `, from: ${vector(cue.from)}` : ""}, position: ${vector(cue.position)}${cue.lookAt ? `, look_at: ${yamlString(cue.lookAt)}` : ""}${cue.visible === false ? ", visible: false" : cue.visible === true ? ", visible: true" : ""}${cue.easing ? `, easing: ${yamlString(cue.easing)}` : ""}${cue.cut ? ", cut: true" : ""} }`,
      ),
    );
  }
  lines.push(
    "observer_shots:",
    `  - { id: "obs-1", start: 0, end: ${Number(totalDuration.toFixed(2))}, target: "center", maneuver: "orbit", distance: 10, pitch: 26, yaw: 30, yaw_end: 60, lens: 35mm }`,
  );
  return {yaml: `${lines.join("\n")}\n`, entities: entities.length, shots: shots.length};
}

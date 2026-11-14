/*
 * The stateless choreography evaluator: `frame = f(t, score)`.
 *
 * Every value is computed from the parsed score and the timestamp only, so
 * scrubbing backwards and playing forwards land on exactly the same state.
 * The formulas follow StageFlow's technical specification sections 2–6:
 * spherical camera projection, the full-frame sensor gate, the maneuver
 * catalogue, the easing curves, and the two-pass blocking evaluator.
 */
import type {
  BlockingCue,
  CameraCue,
  CameraPose,
  Dimensions,
  DofPreset,
  Easing,
  EvaluatedCamera,
  EvaluatedEntity,
  FocusAnchor,
  SceneEntity,
  Shot,
  StageFrame,
  StageScore,
  TargetAnchor,
  Vec3,
} from "./schema";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const SENSOR_WIDTH_MM = 36;
const COC_MM = 0.03;

const shortestArc = (to: number, from: number): number => {
  const turn = 2 * Math.PI;
  return (((to - from + Math.PI) % turn) + turn) % turn - Math.PI;
};

/** Easing curves from the specification (§5.1). `tau` is clamped to [0, 1]. */
export function easingValue(easing: Easing, tau: number): number {
  const t = clamp(tau, 0, 1);
  switch (easing) {
    case "linear":
      return t;
    case "ease-in":
      return t ** 3;
    case "ease-out":
      return 1 - (1 - t) ** 3;
    case "expo":
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      return t < 0.5 ? 0.5 * 2 ** (20 * t - 10) : 1 - 0.5 * 2 ** (-20 * t + 10);
    case "pop":
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      return clamp(1 - Math.exp(-6 * t) * Math.cos(2.5 * Math.PI * t), 0, 1.2);
    case "cruise": {
      const p = 0.25;
      const v = 1 / (1 - p);
      if (t < p) return (v / 2) * (t - (p / Math.PI) * Math.sin((Math.PI * t) / p));
      if (t > 1 - p) {
        const local = t - (1 - p);
        return 1 - (v * p) / 2 + (v / 2) * (local + (p / Math.PI) * Math.sin((Math.PI * local) / p));
      }
      return (v * p) / 2 + v * (t - p);
    }
    case "accel": {
      const p = 0.4;
      const v = 1 / (1 - p / 2);
      return t < p ? (v / 2) * (t - (p / Math.PI) * Math.sin((Math.PI * t) / p)) : (v * p) / 2 + v * (t - p);
    }
    case "deccel": {
      const p = 0.4;
      const v = 1 / (1 - p / 2);
      if (t <= 1 - p) return v * t;
      const local = t - (1 - p);
      return v * (1 - p) + (v / 2) * (local + (p / Math.PI) * Math.sin((Math.PI * local) / p));
    }
    case "smooth":
    default:
      return 0.5 * (1 - Math.cos(Math.PI * t));
  }
}

/** Vertical field of view in degrees for a full-frame lens and a scene aspect ratio (§3). */
export function verticalFovDeg(lensMm: number, aspectRatio: number): number {
  const sensorHeight = SENSOR_WIDTH_MM / Math.max(0.01, aspectRatio);
  return (2 * Math.atan(sensorHeight / (2 * Math.max(1, lensMm))) * 180) / Math.PI;
}

const EYE = (target: Vec3, distance: number, pitch: number, yaw: number): Vec3 => {
  const horizontal = distance * Math.cos(pitch);
  return [
    target[0] + horizontal * Math.sin(yaw),
    target[1] + distance * Math.sin(pitch),
    target[2] + horizontal * Math.cos(yaw),
  ];
};

const pos = (entity: SceneEntity): Vec3 => entity.position;

/** The intrinsic look-at anchor of an entity: eye level for people, centre volume for props and marks (§4.1). */
export function entityAnchor(entity: SceneEntity): Vec3 {
  const ratio = entity.kind === "character" ? 0.9 : 0.5;
  return [pos(entity)[0], pos(entity)[1] + ratio * entity.height, pos(entity)[2]];
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const lerp3 = (a: Vec3, b: Vec3, u: number): Vec3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

/** Resolve a look-at anchor against the evaluated entities of this frame. */
export function resolveAnchor(anchor: TargetAnchor | undefined, entities: Map<string, EvaluatedEntity>, fallback: Vec3): Vec3 {
  if (!anchor) return fallback;
  if (anchor.kind === "point") return [...anchor.point] as Vec3;
  if (anchor.kind === "stage") return [0, 1, 0];
  if (anchor.kind === "entity") {
    const entity = entities.get(anchor.id);
    return entity ? entityAnchor({...entity.def, position: entity.position, height: entity.size.height}) : fallback;
  }
  const points = anchor.ids.map((id) => entities.get(id)).filter((entity): entity is EvaluatedEntity => !!entity);
  if (!points.length) return fallback;
  const sum = points.reduce<Vec3>((total, entity) => add(total, entityAnchor({...entity.def, position: entity.position, height: entity.size.height})), [0, 0, 0]);
  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
}

/** Catmull-Rom interpolation of one scalar component across a pose chain. */
function catmullRomValue(values: number[], u: number): number {
  if (values.length === 1) return values[0];
  const scaled = clamp(u, 0, 1) * (values.length - 1);
  const index = Math.min(values.length - 2, Math.floor(scaled));
  const s = scaled - index;
  const p0 = values[Math.max(0, index - 1)];
  const p1 = values[index];
  const p2 = values[index + 1];
  const p3 = values[Math.min(values.length - 1, index + 2)];
  return 0.5 * (2 * p1 + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s * s + (-p0 + 3 * p1 - 3 * p2 + p3) * s * s * s);
}

/** Up vector for a spherical camera pose, including the Dutch roll basis (§2.1). */
function cameraUp(pitch: number, yaw: number, roll: number): Vec3 {
  const up0: Vec3 = [-Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch), -Math.sin(pitch) * Math.cos(yaw)];
  const right0: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up: Vec3 = [
    Math.cos(roll) * up0[0] + Math.sin(roll) * right0[0],
    Math.cos(roll) * up0[1] + Math.sin(roll) * right0[1],
    Math.cos(roll) * up0[2] + Math.sin(roll) * right0[2],
  ];
  const length = Math.hypot(up[0], up[1], up[2]) || 1;
  return [up[0] / length, up[1] / length, up[2] / length];
}

function focusDistance(cue: CameraCue, u: number, t: number, eye: Vec3, target: Vec3, entities: Map<string, EvaluatedEntity>, score: StageScore): number | undefined {
  const forward: Vec3 = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const length = Math.hypot(forward[0], forward[1], forward[2]) || 1;
  const axis: Vec3 = [forward[0] / length, forward[1] / length, forward[2] / length];
  const project = (point: Vec3) => clamp((point[0] - eye[0]) * axis[0] + (point[1] - eye[1]) * axis[1] + (point[2] - eye[2]) * axis[2], 0.4, 100);
  const distanceOf = (anchor: FocusAnchor | undefined): number | undefined => {
    if (!anchor) return undefined;
    if (anchor.kind === "distance") return clamp(anchor.meters, 0.4, 100);
    return project(resolveAnchor(anchor.anchor, entities, [0, 1, 0]));
  };
  const start = distanceOf(cue.focusStart);
  const end = distanceOf(cue.focusEnd);
  if (start !== undefined && end !== undefined) return start + (end - start) * u;
  const single = distanceOf(cue.focus);
  if (single !== undefined) return single;
  if (score.optics?.defaultDof && score.optics.defaultDof !== "deep") return project([0, 1, 0]);
  void t;
  return undefined;
}

function dofLimits(focus: number | undefined, lensMm: number, cue: CameraCue, score: StageScore): {near?: number; far?: number} {
  const preset: DofPreset | undefined = cue.dof ?? score.optics?.defaultDof;
  const aperture = cue.aperture ?? (preset === "shallow" ? 2.8 : preset === "medium" ? 5.6 : undefined) ?? score.optics?.defaultAperture;
  if (!focus || !aperture || preset === "deep") return {};
  const focal = lensMm / 1000;
  const hyperfocal = (focal * focal) / (Math.max(0.7, aperture) * (COC_MM / 1000)) + focal;
  const near = clamp(((hyperfocal - focal) * focus) / (hyperfocal + focus - 2 * focal), 0.01, 1000);
  const far = focus >= hyperfocal ? Number.POSITIVE_INFINITY : clamp(((hyperfocal - focal) * focus) / (hyperfocal - focus), near, 1000);
  return {near, far: Number.isFinite(far) ? far : undefined};
}

type PosePair = {start: CameraPose; end: CameraPose};

/** Interpolate a camera cue into a world-space camera at time `t` (§5.3). */
export function evaluateCamera(cue: CameraCue, t: number, entities: Map<string, EvaluatedEntity>, score: StageScore): EvaluatedCamera {
  const duration = Math.max(0.016, cue.endSec - cue.startSec);
  const tau = clamp((t - cue.startSec) / duration, 0, 1);
  const u = easingValue(cue.easing, tau);
  const pose: PosePair = {start: cue.start, end: cue.end};
  const startTarget = add(resolveAnchor(pose.start.target, entities, [0, 1, 0]), pose.start.targetOffset);
  const endTarget = add(resolveAnchor(pose.end.target, entities, [0, 1, 0]), pose.end.targetOffset);
  let target = lerp3(startTarget, endTarget, u);
  let distance = pose.start.distance + (pose.end.distance - pose.start.distance) * u;
  let pitch = pose.start.pitch + (pose.end.pitch - pose.start.pitch) * u;
  let yaw = pose.start.yaw + shortestArc(pose.end.yaw, pose.start.yaw) * u;
  let roll = pose.start.roll + shortestArc(pose.end.roll, pose.start.roll) * u;
  let lensMm = pose.start.lensMm + (pose.end.lensMm - pose.start.lensMm) * u;

  switch (cue.maneuver) {
    case "cut":
      target = endTarget;
      distance = pose.end.distance;
      pitch = pose.end.pitch;
      yaw = pose.end.yaw;
      roll = pose.end.roll;
      lensMm = pose.end.lensMm;
      break;
    case "arc": {
      const chord: Vec3 = [endTarget[0] - startTarget[0], endTarget[1] - startTarget[1], endTarget[2] - startTarget[2]];
      const length = Math.hypot(chord[0], chord[1], chord[2]) || 1;
      const midpoint: Vec3 = [(startTarget[0] + endTarget[0]) / 2, (startTarget[1] + endTarget[1]) / 2, (startTarget[2] + endTarget[2]) / 2];
      const control: Vec3 = [midpoint[0] + (0.14 * length * chord[0]) / length, midpoint[1] + 0.16 * length, midpoint[2] + (0.14 * length * chord[2]) / length];
      const inv = 1 - u;
      target = [
        inv * inv * startTarget[0] + 2 * inv * u * control[0] + u * u * endTarget[0],
        inv * inv * startTarget[1] + 2 * inv * u * control[1] + u * u * endTarget[1],
        inv * inv * startTarget[2] + 2 * inv * u * control[2] + u * u * endTarget[2],
      ];
      distance *= 1 + (cue.breathe - 1) * Math.sin(Math.PI * u);
      break;
    }
    case "swoop":
      distance *= 1 + (cue.breathe - 1) * Math.sin(Math.PI * u);
      pitch += 0.08 * Math.sin(Math.PI * u);
      break;
    case "orbit":
    case "sweep":
    case "spiral":
      yaw = pose.start.yaw + cue.yawDelta * u;
      break;
    case "dive":
      distance *= 1 - 0.14 * Math.sin(2 * Math.PI * u);
      pitch -= 0.12 * Math.sin(Math.PI * u);
      break;
    case "recoil":
      distance += (cue.breathe - 1) * pose.start.distance * 3.5 * tau * Math.exp(-5 * tau);
      break;
    case "spline": {
      if (cue.waypoints.length) {
        const chain = [pose.start, ...cue.waypoints, pose.end];
        distance = catmullRomValue(chain.map((entry) => entry.distance), u);
        pitch = catmullRomValue(chain.map((entry) => entry.pitch), u);
        yaw = catmullRomValue(chain.map((entry) => entry.yaw), u);
        roll = catmullRomValue(chain.map((entry) => entry.roll), u);
        lensMm = catmullRomValue(chain.map((entry) => entry.lensMm), u);
      }
      break;
    }
  }
  const eye = EYE(target, distance, pitch, yaw);
  const up = cameraUp(pitch, yaw, roll);
  const focus = focusDistance(cue, u, t, eye, target, entities, score);
  const limits = dofLimits(focus, lensMm, cue, score);
  return {
    eye,
    target,
    up,
    yaw,
    pitch,
    roll,
    distance,
    lensMm,
    fovDeg: verticalFovDeg(lensMm, score.aspectRatio),
    focusDistanceM: focus,
    dofNearM: limits.near,
    dofFarM: limits.far,
  };
}

/** The shot that is active at `t`: the last one that started, holding to the end of the score (§1.3). */
export function shotIndexAt(shots: Shot[], t: number): number {
  let index = -1;
  for (let i = 0; i < shots.length; i++) {
    if (shots[i].startSec <= t) index = i;
    if (shots[i].startSec <= t && t < shots[i].endSec) return i;
  }
  return index;
}

type EntityState = {position: Vec3; rotation: number; size: Dimensions; visible: boolean; highlighted: boolean; trail: Vec3[]};

function baseState(entity: SceneEntity): EntityState {
  return {
    position: [...entity.position] as Vec3,
    rotation: entity.rotation,
    size: {width: entity.width, height: entity.height, depth: entity.depth},
    visible: true,
    highlighted: false,
    trail: [],
  };
}

/** Sample a 16-segment ground trail along a cue. */
function trailOf(from: Vec3, to: Vec3): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i <= 16; i++) points.push(lerp3(from, to, i / 16));
  return points;
}

function heading(from: Vec3, to: Vec3): number {
  return Math.atan2(to[0] - from[0], to[2] - from[2]);
}

/** Pass 1: world positions and visibility of every entity under the decoupled blocking timeline (§6). */
function blockingPositions(score: StageScore, cues: BlockingCue[], t: number): Map<string, EntityState> {
  const states = new Map<string, EntityState>();
  for (const entity of score.entities) states.set(entity.id, baseState(entity));
  for (const cue of cues) {
    const state = states.get(cue.entityId);
    if (!state) continue;
    const duration = Math.max(0.016, cue.endSec - cue.startSec);
    const tau = clamp((t - cue.startSec) / duration, 0, 1);
    if (t < cue.startSec) continue;
    if (t >= cue.endSec) {
      state.position = [...cue.position] as Vec3;
      state.size = {...cue.size};
      state.visible = cue.visible ?? state.visible;
      state.trail = [];
      continue;
    }
    const u = cue.cut ? 1 : easingValue(cue.easing, tau);
    state.position = cue.cut ? [...cue.position] as Vec3 : lerp3(cue.fromPosition, cue.position, u);
    state.size = {
      width: cue.fromSize.width + (cue.size.width - cue.fromSize.width) * u,
      height: cue.fromSize.height + (cue.size.height - cue.fromSize.height) * u,
      depth: cue.fromSize.depth + (cue.size.depth - cue.fromSize.depth) * u,
    };
    state.visible = cue.visible ?? state.visible;
    const displacement = Math.hypot(cue.position[0] - cue.fromPosition[0], cue.position[2] - cue.fromPosition[2]);
    state.trail = cue.cut || displacement <= 0.05 ? [] : trailOf(cue.fromPosition, cue.position);
  }
  return states;
}

/** Pass 2: facing angles with a C0 gaze handoff, then the per-shot highlight layer (§6.2, §6.3). */
function blockingRotations(score: StageScore, cues: BlockingCue[], t: number, positions: Map<string, EntityState>): Map<string, number> {
  const rotations = new Map<string, number>();
  for (const entity of score.entities) rotations.set(entity.id, entity.rotation);
  for (const entity of score.entities) {
    let current = entity.rotation;
    const entityCues = cues.filter((cue) => cue.entityId === entity.id);
    for (const cue of entityCues) {
      const duration = Math.max(0.016, cue.endSec - cue.startSec);
      const startYaw = current;
      let endYaw = current;
      if (cue.lookAt) {
        const positionsAtEnd = blockingPositions(score, cues, cue.endSec);
        const self = positionsAtEnd.get(entity.id)?.position ?? entity.position;
        const targetPoint = resolveAnchor(cue.lookAt, toEvaluated(score, positionsAtEnd), [0, 1, 0]);
        endYaw = Math.atan2(targetPoint[0] - self[0], targetPoint[2] - self[2]);
      } else if (cue.rotation !== undefined) {
        endYaw = cue.rotation;
      } else {
        const moving = Math.hypot(cue.position[0] - cue.fromPosition[0], cue.position[2] - cue.fromPosition[2]) > 0.05;
        if (moving) endYaw = heading(cue.fromPosition, cue.position);
      }
      if (t >= cue.endSec) {
        current = endYaw;
        continue;
      }
      if (t < cue.startSec) break;
      const tau = clamp((t - cue.startSec) / duration, 0, 1);
      if (cue.lookAt) {
        const self = positions.get(entity.id)?.position ?? entity.position;
        const targetPoint = resolveAnchor(cue.lookAt, toEvaluated(score, positions), [0, 1, 0]);
        current = Math.atan2(targetPoint[0] - self[0], targetPoint[2] - self[2]);
      } else {
        const u = cue.cut ? 1 : easingValue(cue.easing, tau);
        current = startYaw + shortestArc(endYaw, startYaw) * u;
      }
      break;
    }
    rotations.set(entity.id, current);
  }
  return rotations;
}

/** Turn the state maps into the evaluated entity list the viewport reads. */
function toEvaluated(score: StageScore, states: Map<string, EntityState>): Map<string, EvaluatedEntity> {
  const result = new Map<string, EvaluatedEntity>();
  for (const entity of score.entities) {
    const state = states.get(entity.id) ?? baseState(entity);
    result.set(entity.id, {
      id: entity.id,
      def: entity,
      position: state.position,
      rotation: state.rotation,
      size: state.size,
      visible: state.visible,
      highlighted: state.highlighted,
      trailPoints: state.trail,
    });
  }
  return result;
}

/** Per-shot entity overrides (tier 2, used when `blocking:` is absent) (§6.4). */
function shotEntityStates(score: StageScore, activeIndex: number, t: number): Map<string, EntityState> {
  const states = new Map<string, EntityState>();
  for (const entity of score.entities) states.set(entity.id, baseState(entity));
  for (let index = 0; index <= activeIndex && index < score.shots.length; index++) {
    const shot = score.shots[index];
    const duration = Math.max(0.016, shot.endSec - shot.startSec);
    const tau = clamp((t - shot.startSec) / duration, 0, 1);
    const isActive = index === activeIndex;
    for (const [entityId, override] of Object.entries(shot.overrides)) {
      const state = states.get(entityId);
      if (!state) continue;
      const from = override.from ?? state.position;
      const to = override.position ?? (override.cut ? from : state.position);
      const startSize = override.fromSize ?? state.size;
      const endSize = override.size ?? startSize;
      if (isActive) {
        const u = override.cut ? 1 : easingValue(override.easing, tau);
        state.position = override.cut ? [...to] as Vec3 : lerp3(from, to, u);
        state.size = {
          width: startSize.width + (endSize.width - startSize.width) * u,
          height: startSize.height + (endSize.height - startSize.height) * u,
          depth: startSize.depth + (endSize.depth - startSize.depth) * u,
        };
        if (override.rotation !== undefined) state.rotation = state.rotation + shortestArc(override.rotation, state.rotation) * u;
        else if (override.lookAt) {
          const target = resolveAnchor(override.lookAt, toEvaluated(score, states), [0, 1, 0]);
          state.rotation = Math.atan2(target[0] - state.position[0], target[2] - state.position[2]);
        } else if (Math.hypot(to[0] - from[0], to[2] - from[2]) > 0.05) state.rotation = state.rotation + shortestArc(heading(from, to), state.rotation) * u;
        if (override.visible !== undefined) state.visible = override.visible;
        state.highlighted = override.highlighted ?? false;
      } else {
        state.position = override.cut ? [...to] as Vec3 : [...to] as Vec3;
        state.size = {...endSize};
        if (override.rotation !== undefined) state.rotation = override.rotation;
        else if (override.lookAt) {
          const target = resolveAnchor(override.lookAt, toEvaluated(score, states), [0, 1, 0]);
          state.rotation = Math.atan2(target[0] - state.position[0], target[2] - state.position[2]);
        }
        if (override.visible !== undefined) state.visible = override.visible;
      }
    }
  }
  return states;
}

/** Evaluate the whole scene at one instant. */
export function evaluateFrame(score: StageScore, rawTime: number): StageFrame {
  const t = clamp(rawTime + score.offsetSec, 0, score.durationSec);
  const activeIndex = shotIndexAt(score.shots, t);
  const activeShot = activeIndex >= 0 ? score.shots[activeIndex] : null;
  const cues = score.blocking ?? [];
  const usingBlocking = cues.length > 0;
  const positions = usingBlocking ? blockingPositions(score, cues, t) : shotEntityStates(score, activeIndex, t);
  if (usingBlocking) {
    const rotations = blockingRotations(score, cues, t, positions);
    for (const [id, rotation] of rotations) {
      const state = positions.get(id);
      if (state) state.rotation = rotation;
    }
    // Highlight layer: cues set an entity's ring while they run, per-shot overrides win.
    for (const state of positions.values()) state.highlighted = false;
    for (const cue of cues) {
      if (cue.highlighted === undefined || t < cue.startSec || t >= cue.endSec) continue;
      const state = positions.get(cue.entityId);
      if (state) state.highlighted = cue.highlighted;
    }
    if (activeShot) {
      for (const [entityId, override] of Object.entries(activeShot.overrides)) {
        if (override.highlighted === undefined) continue;
        const state = positions.get(entityId);
        if (state) state.highlighted = override.highlighted;
      }
    }
  }
  const entities = toEvaluated(score, positions);
  const map = entities;
  const baseline = evaluateBaseline(score);
  let stageCamera = baseline.stage;
  if (activeShot?.camera) stageCamera = evaluateCamera(activeShot.camera, t, map, score);
  let observerCamera = baseline.observer;
  if (score.observerShots?.length) {
    const active = score.observerShots.filter((cue) => cue.startSec <= t && t < cue.endSec).pop() ?? [...score.observerShots].filter((cue) => cue.endSec <= t).pop();
    if (active) observerCamera = evaluateCamera(active, t, map, score);
  } else if (activeShot?.observerCamera) {
    observerCamera = evaluateCamera(activeShot.observerCamera, t, map, score);
  }
  return {timeSec: t, entities: [...entities.values()], stageCamera, observerCamera, activeShotIndex: activeIndex, activeShot, shotCount: score.shots.length};
}

/** The static baseline cameras, evaluated as ordinary poses so the viewport has a uniform shape. */
export function evaluateBaseline(score: StageScore): {stage: EvaluatedCamera; observer: EvaluatedCamera} {
  const empty = new Map<string, EvaluatedEntity>();
  const pose = (baseline: CameraPose): EvaluatedCamera => {
    const target = add(resolveAnchor(baseline.target, empty, [0, 1, 0]), baseline.targetOffset);
    const eye = EYE(target, baseline.distance, baseline.pitch, baseline.yaw);
    return {
      eye,
      target,
      up: cameraUp(baseline.pitch, baseline.yaw, baseline.roll),
      yaw: baseline.yaw,
      pitch: baseline.pitch,
      roll: baseline.roll,
      distance: baseline.distance,
      lensMm: baseline.lensMm,
      fovDeg: verticalFovDeg(baseline.lensMm, score.aspectRatio),
    };
  };
  return {stage: pose(score.stage.stagePose), observer: pose(score.stage.observerPose)};
}

/** A readable clock for the timeline: mm:ss.hh. */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

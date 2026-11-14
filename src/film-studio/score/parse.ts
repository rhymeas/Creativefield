/*
 * Turns a StageFlow `*.yaml` choreography score into the normalized model the
 * evaluator and the viewport use.
 *
 * Rules that matter here, taken from the StageFlow authoring manual and
 * technical specification:
 *  - angles are human degrees unless a value carries a `rad`, `deg` or `°` suffix;
 *  - a standard cut resets roll and target offset when they are omitted, while a
 *    continuous take inherits both from the previous cue;
 *  - a single value holds a static pose in a standard cut, but is a destination in
 *    a continuous take (the start glides from the previous terminal pose);
 *  - `blocking:` and `observer_shots:` are decoupled timelines that span cuts.
 *
 * The parser keeps going on recoverable problems and records warnings, so a
 * score with one bad field still opens and shows what it can.
 */
import type {
  BlockingCue,
  CameraCue,
  CameraPose,
  Dimensions,
  DofPreset,
  Direction,
  Easing,
  EntityKind,
  EntityOverride,
  EntityShape,
  EntityStyle,
  FocusAnchor,
  Maneuver,
  SceneEntity,
  Shot,
  StageScore,
  TargetAnchor,
  Vec3,
  YamlDiagnostic,
  YamlValue,
} from "./schema";
import {parseYaml} from "./yaml";

const DEFAULT_ASPECT = 16 / 9;
const DEFAULT_DURATION_SEC = 10;
const MIN_SHOT_SEC = 0.1;
const MIN_BLOCKING_SEC = 0.016;

const CHARACTER_DIMENSIONS = {height: 1.75, radius: 0.26, width: 0.52, depth: 0.52};
const PROP_DIMENSIONS = {height: 0.85, radius: 0.35, width: 0.7, depth: 0.7};
const MARKER_DIMENSIONS = {height: 0.15, radius: 0.25, width: 0.5, depth: 0.5};

const ENTITY_COLORS: Record<EntityKind, string> = {character: "#38bdf8", prop: "#94a3b8", marker: "#fb7185"};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const rad = (degrees: number) => (degrees * Math.PI) / 180;
const deg = (radians: number) => (radians * 180) / Math.PI;

type Dict = Record<string, YamlValue>;
const isDict = (value: YamlValue | undefined): value is Dict => !!value && typeof value === "object" && !Array.isArray(value);
const dict = (value: YamlValue | undefined): Dict => (isDict(value) ? value : {});
const list = (value: YamlValue | undefined): YamlValue[] => (Array.isArray(value) ? value : []);

/** First value among aliases that is not null or undefined. */
function pick(source: Dict, ...names: string[]): YamlValue | undefined {
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function text(value: YamlValue | undefined, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function numberAt(value: YamlValue | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(value.trim());
    if (match) {
      const parsed = Number(match[0]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

function optionalNumber(value: YamlValue | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = numberAt(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function flag(value: YamlValue | undefined, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "yes" || lower === "on") return true;
    if (lower === "false" || lower === "no" || lower === "off") return false;
  }
  return fallback;
}

/** Angles arrive as degrees by default; `"45deg"`, `"45°"` and `"1.57rad"` suffixes are honoured. */
function angleRad(value: YamlValue | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return rad(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/[-+]?\d*\.?\d+\s*rad$/i.test(trimmed)) return numberAt(trimmed, deg(fallback) as number);
    return rad(numberAt(trimmed, deg(fallback) as number));
  }
  return fallback;
}

function lensMm(value: YamlValue | undefined, fallback: number): number {
  const parsed = numberAt(value, fallback);
  return clamp(Number.isFinite(parsed) ? parsed : fallback, 12, 200);
}

function vec3(value: YamlValue | undefined, fallback: Vec3): Vec3 {
  if (Array.isArray(value) && value.length >= 3) {
    return [numberAt(value[0], fallback[0]), numberAt(value[1], fallback[1]), numberAt(value[2], fallback[2])];
  }
  if (isDict(value)) return [numberAt(value.x, fallback[0]), numberAt(value.y, fallback[1]), numberAt(value.z, fallback[2])];
  if (Array.isArray(value) && value.length === 2) return [numberAt(value[0], fallback[0]), fallback[1], numberAt(value[1], fallback[2])];
  return [...fallback];
}

const isVecValue = (value: YamlValue): boolean => Array.isArray(value) && value.length >= 2 && typeof value[0] === "number";

/** Resolve a look-at anchor: entity id or label, stage preset, world point, or a multi-entity centroid. */
function anchor(value: YamlValue | undefined): TargetAnchor | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const lower = trimmed.toLowerCase();
    if (lower === "center" || lower === "origin" || lower === "stage") return {kind: "stage"};
    return {kind: "entity", id: trimmed};
  }
  if (Array.isArray(value)) {
    if (isVecValue(value)) return {kind: "point", point: vec3(value, [0, 0, 0])};
    const ids = value.filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.trim());
    if (ids.length === 1) return {kind: "entity", id: ids[0]};
    if (ids.length > 1) return {kind: "centroid", ids};
    return undefined;
  }
  if (isDict(value) && (value.x !== undefined || value.y !== undefined || value.z !== undefined)) {
    return {kind: "point", point: vec3(value, [0, 0, 0])};
  }
  return undefined;
}

function focusAnchor(value: YamlValue | undefined): FocusAnchor | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return {kind: "distance", meters: clamp(value, 0.4, 100)};
  if (typeof value === "string" && /^[-+]?\d*\.?\d+\s*m?$/i.test(value.trim())) {
    return {kind: "distance", meters: clamp(numberAt(value, 3), 0.4, 100)};
  }
  const resolved = anchor(value);
  return resolved ? {kind: "anchor", anchor: resolved} : undefined;
}

function aspect(value: YamlValue | undefined): number {
  if (typeof value === "number" && value > 0) return value;
  if (typeof value === "string") {
    const match = /^(\d*\.?\d+)\s*:\s*(\d*\.?\d+)$/.exec(value.trim());
    if (match) {
      const width = Number(match[1]);
      const height = Number(match[2]);
      if (width > 0 && height > 0) return width / height;
    }
    const plain = Number(value);
    if (Number.isFinite(plain) && plain > 0) return plain;
  }
  return DEFAULT_ASPECT;
}

const EASINGS: Record<string, Easing> = {
  smooth: "smooth",
  linear: "linear",
  "ease-in": "ease-in",
  easein: "ease-in",
  "ease-out": "ease-out",
  easeout: "ease-out",
  expo: "expo",
  pop: "pop",
  bounce: "pop",
  cruise: "cruise",
  trapezoid: "cruise",
  accel: "accel",
  "ramp-up": "accel",
  deccel: "deccel",
  decel: "deccel",
  "ramp-down": "deccel",
};

const MANEUVERS: Record<string, Maneuver> = {
  cut: "cut",
  static: "cut",
  hold: "cut",
  dolly: "dolly",
  straight: "dolly",
  linear: "dolly",
  push: "dolly",
  pull: "dolly",
  arc: "arc",
  swoop: "swoop",
  orbit: "orbit",
  turntable: "orbit",
  sweep: "sweep",
  pan: "sweep",
  spiral: "spiral",
  corkscrew: "spiral",
  dive: "dive",
  flyby: "dive",
  recoil: "recoil",
  punch: "recoil",
  spline: "spline",
  path: "spline",
};

function easing(value: YamlValue | undefined): Easing {
  const name = text(value, "").trim().toLowerCase();
  return EASINGS[name] ?? "smooth";
}

function maneuver(value: YamlValue | undefined): Maneuver {
  const name = text(value, "").trim().toLowerCase();
  return MANEUVERS[name] ?? "dolly";
}

function direction(value: YamlValue | undefined): {direction: Direction; explicit: boolean} {
  const name = text(value, "").trim().toLowerCase();
  if (name === "ccw" || name === "counterclockwise" || name === "counter-clockwise") return {direction: "ccw", explicit: true};
  if (name === "cw" || name === "clockwise") return {direction: "cw", explicit: true};
  return {direction: "cw", explicit: false};
}

function kind(value: YamlValue | undefined): EntityKind {
  const name = text(value, "").trim().toLowerCase();
  if (["actor", "person", "character", "human", "player"].includes(name)) return "character";
  if (["spike", "mark", "marker", "tape"].includes(name)) return "marker";
  return "prop";
}

const SHAPES: Record<string, EntityShape> = {
  box: "box",
  cube: "box",
  sphere: "sphere",
  ball: "sphere",
  cylinder: "cylinder",
  column: "cylinder",
  can: "cylinder",
  cup: "cylinder",
  capsule: "capsule",
  pill: "capsule",
  x: "x",
  t: "t",
  "t-mark": "t",
  t_mark: "t",
  circle: "circle",
  ring: "circle",
  dot: "circle",
  puck: "puck",
  disc: "puck",
};

const STYLES: Record<string, EntityStyle> = {
  mannequin: "mannequin",
  edges: "edges",
  hologram: "edges",
  cad: "edges",
  silhouette: "silhouette",
  ink: "silhouette",
  flat: "silhouette",
  wireframe: "wireframe",
  wire: "wireframe",
  lines: "wireframe",
  glass: "glass",
  ghost: "glass",
  translucent: "glass",
  solid: "solid",
  opaque: "solid",
  matte: "solid",
  tape: "tape",
  glow: "glow",
  pulse: "glow",
  luminous: "glow",
  beacon: "beacon",
  pin: "beacon",
  stand: "beacon",
};

function dims(value: YamlValue | undefined): {width?: number; height?: number; depth?: number} {
  if (Array.isArray(value)) {
    if (value.length === 3) return {width: optionalNumber(value[0]), height: optionalNumber(value[1]), depth: optionalNumber(value[2])};
    if (value.length === 2) return {width: optionalNumber(value[0]), depth: optionalNumber(value[1])};
  }
  return {};
}

/** Read `size: [w, h, d]`, scalar width/height/depth, and derive radius the way the engine does. */
function entityDimensions(source: Dict, base: Dimensions & {radius: number}): Dimensions & {radius: number} {
  const size = dims(pick(source, "size", "dimensions"));
  let width = optionalNumber(pick(source, "width", "w")) ?? size.width ?? (pick(source, "radius") === undefined ? base.width : base.radius * 2);
  let height = optionalNumber(pick(source, "height", "h")) ?? size.height ?? base.height;
  let depth = optionalNumber(pick(source, "depth", "length", "d")) ?? size.depth ?? (pick(source, "width") !== undefined && pick(source, "depth") === undefined ? width : base.depth);
  if (width <= 0) width = base.width;
  if (height <= 0) height = base.height;
  if (depth <= 0) depth = base.depth;
  const radius = optionalNumber(pick(source, "radius", "r")) ?? Math.max(width, depth) / 2;
  return {width, height, depth, radius};
}

function defaultEntity(source: Dict, index: number, warnings: YamlDiagnostic[]): SceneEntity | null {
  const rawId = pick(source, "id", "key");
  const id = typeof rawId === "string" && rawId.trim() ? rawId.trim() : "";
  if (!id) {
    warnings.push({line: 0, message: `Entity ${index + 1} has no id and was skipped.`, severity: "warning"});
    return null;
  }
  const entityKind = kind(pick(source, "kind", "type"));
  const base = entityKind === "character" ? CHARACTER_DIMENSIONS : entityKind === "marker" ? MARKER_DIMENSIONS : PROP_DIMENSIONS;
  let dimensions = entityDimensions(source, {...base});
  const shapeName = text(pick(source, "shape"), "").trim().toLowerCase();
  const shape = SHAPES[shapeName];
  if (entityKind === "prop" && shape === "sphere" && pick(source, "height", "h", "size") === undefined) dimensions = {...dimensions, height: dimensions.radius * 2};
  const styleName = text(pick(source, "style"), "").trim().toLowerCase();
  const style = STYLES[styleName] ?? (entityKind === "character" ? "mannequin" : entityKind === "marker" ? "tape" : "edges");
  return {
    id,
    label: text(pick(source, "label", "name"), id),
    kind: entityKind,
    shape: entityKind === "character" ? undefined : shape ?? (entityKind === "marker" ? "x" : "box"),
    style,
    position: vec3(pick(source, "position", "pos", "at"), [0, 0, 0]),
    rotation: angleRad(pick(source, "rotation", "yaw", "rotation_y"), 0),
    height: dimensions.height,
    width: dimensions.width,
    depth: dimensions.depth,
    radius: dimensions.radius,
    color: text(pick(source, "color", "token"), ENTITY_COLORS[entityKind]),
  };
}

function baselinePose(source: Dict, fallback: CameraPose): CameraPose {
  if (!Object.keys(source).length) return {...fallback, targetOffset: [...fallback.targetOffset] as Vec3};
  const target = anchor(pick(source, "target", "look_at", "lookAt")) ?? fallback.target;
  return {
    target,
    targetOffset: vec3(pick(source, "target_offset", "targetOffset"), fallback.targetOffset),
    distance: clamp(numberAt(pick(source, "distance"), fallback.distance), 0.4, 100),
    pitch: clamp(angleRad(pick(source, "pitch"), fallback.pitch), rad(-85), rad(85)),
    yaw: angleRad(pick(source, "yaw"), fallback.yaw),
    roll: angleRad(pick(source, "roll", "dutch"), fallback.roll),
    lensMm: lensMm(pick(source, "lens", "focal_length", "focalLengthMm"), fallback.lensMm),
  };
}

const DEFAULT_OBSERVER_POSE: CameraPose = {target: {kind: "stage"}, targetOffset: [0, 0, 0], distance: 7.5, pitch: rad(26), yaw: rad(38), roll: 0, lensMm: 35};
const DEFAULT_STAGE_POSE: CameraPose = {target: {kind: "stage"}, targetOffset: [0, 0, 0], distance: 3.2, pitch: rad(6), yaw: rad(-25), roll: 0, lensMm: 50};

const copyPose = (pose: CameraPose): CameraPose => ({...pose, targetOffset: [...pose.targetOffset] as Vec3});

/** Shortest-arc difference between two yaw angles, in [-π, π]. */
function shortestArc(to: number, from: number): number {
  const turn = 2 * Math.PI;
  return (((to - from + Math.PI) % turn) + turn) % turn - Math.PI;
}

type CueContext = {
  previous: CameraPose;
  baseline: CameraPose;
  continuous: boolean;
  durationSec: number;
};

/**
 * Normalize one camera cue. `continuous` decides whether omitted start values
 * inherit the previous terminal pose (continuous take) or reset (standard cut).
 */
function cameraCue(source: Dict, id: string, startSec: number, endSec: number, context: CueContext): CameraCue {
  const move = maneuver(pick(source, "maneuver", "style"));
  const ease = easing(pick(source, "easing"));
  const dir = direction(pick(source, "direction", "clockwise", "counterclockwise"));
  const previous = copyPose(context.previous);
  const durationSec = Math.max(MIN_SHOT_SEC, endSec - startSec);
  const continuous = context.continuous;
  const targetAnchor = anchor(pick(source, "target")) ?? previous.target;
  const fromAnchor = anchor(pick(source, "from"));
  const breathe = numberAt(pick(source, "breathe"), move === "arc" || move === "swoop" ? 1.12 : move === "recoil" ? 1.25 : 1);
  const revolutions = optionalNumber(pick(source, "revolutions"));
  const orbitSpeedRad = rad(numberAt(pick(source, "orbit_speed", "orbitSpeed"), 0));
  const yawDeltaRad = rad(numberAt(pick(source, "yaw_delta", "yawDelta"), 0));
  const yawStartAuthor = optionalNumber(pick(source, "yaw_start", "yawStart"));
  const yawEndAuthor = optionalNumber(pick(source, "yaw_end", "yawEnd"));
  const singleYaw = optionalNumber(pick(source, "yaw"));
  const singleDistance = optionalNumber(pick(source, "distance"));
  const singlePitch = optionalNumber(pick(source, "pitch"));
  const singleRoll = optionalNumber(pick(source, "roll", "dutch"));
  const singleLens = pick(source, "lens", "focal_length", "focalLengthMm");
  const rotationMove = move === "orbit" || move === "sweep" || move === "spiral";

  // Standard cuts reset roll and target offset; continuous takes keep them.
  const rollDefault = continuous ? previous.roll : 0;
  const offsetDefault: Vec3 = continuous ? previous.targetOffset : [0, 0, 0];
  const start: CameraPose = {
    target: fromAnchor ?? targetAnchor,
    targetOffset: vec3(pick(source, "target_offset_start", "targetOffsetStart"), offsetDefault),
    distance: clamp(numberAt(pick(source, "distance_start"), previous.distance), 0.4, 100),
    pitch: clamp(angleRad(pick(source, "pitch_start", "pitchStart"), previous.pitch), rad(-85), rad(85)),
    yaw: angleRad(pick(source, "yaw_start", "yawStart"), previous.yaw),
    roll: clamp(angleRad(pick(source, "roll_start", "rollStart"), rollDefault), -Math.PI * 4, Math.PI * 4),
    lensMm: pick(source, "lens_start") === undefined ? previous.lensMm : lensMm(pick(source, "lens_start"), previous.lensMm),
  };
  const end: CameraPose = copyPose(start);
  end.target = targetAnchor;
  end.targetOffset = vec3(pick(source, "target_offset_end", "targetOffsetEnd"), vec3(pick(source, "target_offset", "targetOffset"), offsetDefault));
  end.distance = clamp(numberAt(pick(source, "distance_end"), singleDistance ?? start.distance), 0.4, 100);
  const endPitch = optionalNumber(pick(source, "pitch_end", "pitchEnd")) ?? singlePitch;
  end.pitch = clamp(endPitch === undefined ? start.pitch : rad(endPitch), rad(-85), rad(85));
  const endRoll = optionalNumber(pick(source, "roll_end", "rollEnd")) ?? singleRoll;
  end.roll = clamp(endRoll === undefined ? start.roll : rad(endRoll), -Math.PI * 4, Math.PI * 4);
  end.lensMm = lensMm(pick(source, "lens_end", "lens", "focal_length", "focalLengthMm"), start.lensMm);
  // A standard cut treats a single value as a static hold; a continuous take glides into it.
  if (!continuous) {
    if (singleDistance !== undefined && pick(source, "distance_start") === undefined) start.distance = clamp(singleDistance, 0.4, 100);
    if (singlePitch !== undefined && pick(source, "pitch_start", "pitchStart") === undefined) start.pitch = clamp(rad(singlePitch), rad(-85), rad(85));
    if (singleRoll !== undefined && pick(source, "roll_start", "rollStart") === undefined) start.roll = clamp(rad(singleRoll), -Math.PI * 4, Math.PI * 4);
    if (singleLens !== undefined && pick(source, "lens_start") === undefined) start.lensMm = lensMm(singleLens, start.lensMm);
  }

  // Yaw for orbit-like moves resolves in the engine's 7-step priority.
  let yawDelta = 0;
  if (rotationMove) {
    const directed = (from: number, to: number) => {
      const short = shortestArc(to, from);
      if (!dir.explicit) return short;
      if (dir.direction === "ccw") return short >= 0 ? short : short + 2 * Math.PI;
      return short <= 0 ? short : short - 2 * Math.PI;
    };
    if (revolutions !== undefined) yawDelta = (dir.direction === "ccw" ? 1 : -1) * 2 * Math.PI * revolutions;
    else if (orbitSpeedRad) yawDelta = (dir.direction === "ccw" ? 1 : -1) * orbitSpeedRad * durationSec;
    else if (yawDeltaRad) yawDelta = yawDeltaRad;
    else if (dir.explicit && (yawEndAuthor !== undefined || singleYaw !== undefined)) yawDelta = directed(start.yaw, rad(yawEndAuthor ?? singleYaw ?? deg(start.yaw)));
    else if (yawStartAuthor !== undefined && yawEndAuthor !== undefined) yawDelta = rad(yawEndAuthor) - rad(yawStartAuthor);
    else if (!dir.explicit && (yawEndAuthor !== undefined || singleYaw !== undefined)) yawDelta = shortestArc(rad(yawEndAuthor ?? singleYaw ?? deg(start.yaw)), start.yaw);
    else yawDelta = (dir.direction === "ccw" ? 1 : -1) * (Math.PI / 4);
    if (move === "spiral" && revolutions === undefined && !orbitSpeedRad) yawDelta = (dir.direction === "ccw" ? 1 : -1) * 0.5 * 2 * Math.PI;
    end.yaw = start.yaw + yawDelta;
  } else if (singleYaw !== undefined && yawEndAuthor === undefined) {
    // A single yaw is the destination; a standard cut holds it, a continuous take glides into it.
    end.yaw = rad(singleYaw);
    if (!continuous) start.yaw = end.yaw;
  } else {
    end.yaw = rad(yawEndAuthor ?? optionalNumber(pick(source, "yaw")) ?? deg(start.yaw));
  }
  end.yaw = Number.isFinite(end.yaw) ? end.yaw : start.yaw;
  if (move === "cut") {
    start.target = end.target;
    start.targetOffset = [...end.targetOffset] as Vec3;
    start.distance = end.distance;
    start.pitch = end.pitch;
    start.yaw = end.yaw;
    start.roll = end.roll;
    start.lensMm = end.lensMm;
  }

  const waypoints: CameraPose[] = [];
  if (move === "spline") {
    let previousPose = copyPose(start);
    for (const entry of list(pick(source, "waypoints"))) {
      const waypoint = dict(entry);
      const pose = copyPose(previousPose);
      pose.target = anchor(pick(waypoint, "target")) ?? previousPose.target;
      pose.targetOffset = vec3(pick(waypoint, "target_offset", "targetOffset"), previousPose.targetOffset);
      pose.distance = clamp(numberAt(pick(waypoint, "distance"), previousPose.distance), 0.4, 100);
      pose.pitch = clamp(angleRad(pick(waypoint, "pitch"), previousPose.pitch), rad(-85), rad(85));
      pose.yaw = angleRad(pick(waypoint, "yaw"), previousPose.yaw);
      pose.roll = angleRad(pick(waypoint, "roll"), previousPose.roll);
      pose.lensMm = lensMm(pick(waypoint, "lens", "focal_length"), previousPose.lensMm);
      waypoints.push(pose);
      previousPose = pose;
    }
  }

  const dofName = text(pick(source, "dof", "depth_of_field", "depthOfField"), "").trim().toLowerCase();
  const dof: DofPreset | undefined = dofName === "shallow" || dofName === "medium" || dofName === "deep" ? dofName : undefined;
  return {
    id,
    startSec,
    endSec,
    continuous,
    maneuver: move,
    easing: ease,
    start,
    end,
    yawDelta,
    breathe,
    waypoints,
    focus: focusAnchor(pick(source, "focus", "focus_target", "focusTarget")) ?? focusAnchor(pick(source, "focus_distance", "focusDistance", "focus_dist")),
    focusStart: focusAnchor(pick(source, "focus_start", "focusStart")),
    focusEnd: focusAnchor(pick(source, "focus_end", "focusEnd")),
    dof,
    aperture: optionalNumber(pick(source, "aperture", "f_stop", "fStop", "t_stop", "apertureFStop")),
    apertureStart: optionalNumber(pick(source, "aperture_start", "apertureStart", "f_stop_start", "dof_start")),
    apertureEnd: optionalNumber(pick(source, "aperture_end", "apertureEnd", "f_stop_end", "dof_end")),
  };
}

function entityOverride(source: Dict): EntityOverride {
  const result: EntityOverride = {easing: easing(pick(source, "easing"))};
  const from = pick(source, "from", "from_position", "fromPosition");
  if (from !== undefined) result.from = vec3(from, [0, 0, 0]);
  const position = pick(source, "position", "pos");
  if (position !== undefined) result.position = vec3(position, [0, 0, 0]);
  const rotation = optionalNumber(pick(source, "rotation", "yaw"));
  if (rotation !== undefined) result.rotation = rad(rotation);
  const lookAt = anchor(pick(source, "look_at", "lookAt"));
  if (lookAt) result.lookAt = lookAt;
  const cut = pick(source, "cut");
  if (cut !== undefined) result.cut = flag(cut, false);
  const highlighted = pick(source, "highlighted", "highlight");
  if (highlighted !== undefined) result.highlighted = flag(highlighted, false);
  const visible = pick(source, "visible");
  if (visible !== undefined) result.visible = flag(visible, true);
  const size = dims(pick(source, "size"));
  const width = optionalNumber(pick(source, "width"));
  const height = optionalNumber(pick(source, "height"));
  const depth = optionalNumber(pick(source, "depth", "length"));
  if (size.width !== undefined || size.height !== undefined || size.depth !== undefined || width !== undefined || height !== undefined || depth !== undefined) {
    result.size = {
      width: width ?? size.width ?? 0,
      height: height ?? size.height ?? 0,
      depth: depth ?? size.depth ?? 0,
    };
  }
  const fromSize = dims(pick(source, "from_size", "fromSize"));
  const fromWidth = optionalNumber(pick(source, "from_width", "fromWidth"));
  const fromHeight = optionalNumber(pick(source, "from_height", "fromHeight"));
  const fromDepth = optionalNumber(pick(source, "from_depth", "fromDepth"));
  if (fromSize.width !== undefined || fromSize.height !== undefined || fromSize.depth !== undefined || fromWidth !== undefined || fromHeight !== undefined || fromDepth !== undefined) {
    result.fromSize = {
      width: fromWidth ?? fromSize.width ?? 0,
      height: fromHeight ?? fromSize.height ?? 0,
      depth: fromDepth ?? fromSize.depth ?? 0,
    };
  }
  return result;
}

type BlockingState = {position: Vec3; size: Dimensions; visible: boolean};

/** Normalize the decoupled blocking timeline, chaining start poses per entity in document order. */
function blockingCues(entries: YamlValue[], rootContinuous: boolean, warnings: YamlDiagnostic[], entities: Map<string, SceneEntity>): BlockingCue[] {
  const cues: BlockingCue[] = [];
  const state = new Map<string, BlockingState>();
  const defaults = new Map<string, Dimensions>();
  for (const entity of entities.values()) {
    state.set(entity.id, {position: [...entity.position] as Vec3, size: {width: entity.width, height: entity.height, depth: entity.depth}, visible: true});
    defaults.set(entity.id, {width: entity.width, height: entity.height, depth: entity.depth});
  }
  let previousEnd = 0;
  let index = 0;
  for (const entry of entries) {
    const source = dict(entry);
    const sharedStart = optionalNumber(pick(source, "start", "_start"));
    const duration = optionalNumber(pick(source, "duration", "dur"));
    const sharedEnd = optionalNumber(pick(source, "end", "_end")) ?? (sharedStart !== undefined || duration !== undefined ? (sharedStart ?? previousEnd) + (duration ?? 1) : undefined);
    const cueContinuous = pick(source, "continuous") === undefined ? rootContinuous : flag(pick(source, "continuous"), rootContinuous);
    const startSec = sharedStart ?? (cueContinuous ? previousEnd : 0);
    const endSec = Math.max(startSec + MIN_BLOCKING_SEC, sharedEnd ?? startSec + 1);
    const sharedEasing = easing(pick(source, "easing"));
    const beats: Array<{id: string; beat: Dict}> = [];
    const single = pick(source, "entity", "actor", "subject", "entity_id");
    if (single !== undefined && typeof single === "string") beats.push({id: single, beat: source});
    const multi = dict(pick(source, "entities"));
    for (const [id, beat] of Object.entries(multi)) if (isDict(beat)) beats.push({id, beat});
    if (!beats.length) {
      warnings.push({line: 0, message: `Blocking cue ${index + 1} names no entity and was skipped.`, severity: "warning"});
      continue;
    }
    for (const {id, beat} of beats) {
      const key = id.trim();
      const previousState = state.get(key);
      const base = previousState ?? {position: [0, 0, 0] as Vec3, size: defaults.get(key) ?? {width: 0.7, height: 0.85, depth: 0.7}, visible: true};
      const from = pick(beat, "from", "from_position", "fromPosition");
      const position = pick(beat, "position", "pos");
      const fromPosition = from !== undefined ? vec3(from, base.position) : [...base.position] as Vec3;
      const toPosition = position !== undefined ? vec3(position, base.position) : [...fromPosition] as Vec3;
      const size = dims(pick(beat, "size"));
      const width = optionalNumber(pick(beat, "width"));
      const height = optionalNumber(pick(beat, "height"));
      const depth = optionalNumber(pick(beat, "depth", "length"));
      const fromSize = dims(pick(beat, "from_size", "fromSize"));
      const fromWidth = optionalNumber(pick(beat, "from_width", "fromWidth"));
      const fromHeight = optionalNumber(pick(beat, "from_height", "fromHeight"));
      const fromDepth = optionalNumber(pick(beat, "from_depth", "fromDepth"));
      const startSize: Dimensions = {
        width: fromWidth ?? fromSize.width ?? base.size.width,
        height: fromHeight ?? fromSize.height ?? base.size.height,
        depth: fromDepth ?? fromSize.depth ?? base.size.depth,
      };
      const endSize: Dimensions = {
        width: width ?? size.width ?? startSize.width,
        height: height ?? size.height ?? startSize.height,
        depth: depth ?? size.depth ?? startSize.depth,
      };
      const rotation = optionalNumber(pick(beat, "rotation", "yaw"));
      const lookAt = anchor(pick(beat, "look_at", "lookAt"));
      const visible = pick(beat, "visible") === undefined ? base.visible : flag(pick(beat, "visible"), base.visible);
      const highlighted = pick(beat, "highlighted", "highlight");
      cues.push({
        id: text(pick(source, "id"), `blocking-${index + 1}-${key}`),
        label: pick(source, "label") === undefined ? undefined : text(pick(source, "label"), ""),
        entityId: key,
        startSec,
        endSec,
        fromPosition,
        position: toPosition,
        fromSize: startSize,
        size: endSize,
        rotation: rotation === undefined ? undefined : rad(rotation),
        lookAt,
        easing: pick(beat, "easing") === undefined ? sharedEasing : easing(pick(beat, "easing")),
        cut: flag(pick(beat, "cut", "jump", "instant"), false),
        visible: pick(beat, "visible") === undefined ? undefined : visible,
        highlighted: highlighted === undefined ? undefined : flag(highlighted, false),
        note: pick(beat, "note", "description") === undefined ? undefined : text(pick(beat, "note", "description"), ""),
        continuous: cueContinuous,
      });
      state.set(key, {position: toPosition, size: endSize, visible});
      defaults.set(key, endSize);
    }
    previousEnd = Math.max(previousEnd, endSec);
    index++;
  }
  return cues;
}

function normalizeShot(entry: YamlValue, index: number, context: {rootContinuous: boolean; previousShot: Shot | null; stage: {observerPose: CameraPose; stagePose: CameraPose}; warnings: YamlDiagnostic[]}): Shot {
  const source = dict(entry);
  const id = text(pick(source, "id", "slug"), `shot-${index + 1}`);
  const label = text(pick(source, "label", "name"), `Shot ${index + 1}`);
  const description = text(pick(source, "description", "note"), "");
  const previous = context.previousShot;
  const explicitStart = optionalNumber(pick(source, "start", "_start"));
  const shotContinuous = pick(source, "continuous") === undefined ? context.rootContinuous : flag(pick(source, "continuous"), context.rootContinuous);
  const startSec = explicitStart ?? (shotContinuous && previous ? previous.endSec : 0);
  const explicitEnd = optionalNumber(pick(source, "end", "_end"));
  const endSec = Math.max(startSec + MIN_SHOT_SEC, explicitEnd ?? startSec + 5);
  const cameraSource = dict(pick(source, "stage_camera", "stageCamera", "camera"));
  const camera = Object.keys(cameraSource).length
    ? cameraCue(cameraSource, `${id}-camera`, startSec, endSec, {
        previous: previous?.camera ? previous.camera.end : context.stage.stagePose,
        baseline: context.stage.stagePose,
        continuous: shotContinuous,
        durationSec: endSec - startSec,
      })
    : null;
  const observerSource = dict(pick(source, "observer_camera", "observerCamera"));
  const observerCamera = Object.keys(observerSource).length
    ? cameraCue(observerSource, `${id}-observer`, startSec, endSec, {
        previous: previous?.observerCamera ? previous.observerCamera.end : context.stage.observerPose,
        baseline: context.stage.observerPose,
        continuous: shotContinuous,
        durationSec: endSec - startSec,
      })
    : null;
  const overrides: Record<string, EntityOverride> = {};
  for (const [entityId, override] of Object.entries(dict(pick(source, "entities")))) {
    if (isDict(override)) overrides[entityId] = entityOverride(override);
  }
  return {
    id,
    shotNumber: optionalNumber(pick(source, "shot")) ?? index + 1,
    label,
    description,
    startSec,
    endSec,
    continuous: shotContinuous,
    camera,
    observerCamera,
    overrides,
  };
}

function observerCues(entries: YamlValue[], stage: {observerPose: CameraPose}, rootContinuous: boolean): CameraCue[] {
  const cues: CameraCue[] = [];
  let previousEnd = 0;
  let previousPose = copyPose(stage.observerPose);
  for (let index = 0; index < entries.length; index++) {
    const source = dict(entries[index]);
    const cueContinuous = pick(source, "continuous") === undefined ? rootContinuous : flag(pick(source, "continuous"), rootContinuous);
    const explicitStart = optionalNumber(pick(source, "start", "_start"));
    const startSec = explicitStart ?? (cueContinuous ? previousEnd : 0);
    const endSec = Math.max(startSec + MIN_SHOT_SEC, optionalNumber(pick(source, "end", "_end")) ?? startSec + 5);
    const cameraSource = Object.keys(dict(pick(source, "camera", "observer_camera", "observerCamera"))).length
      ? dict(pick(source, "camera", "observer_camera", "observerCamera"))
      : source;
    const cue = cameraCue(cameraSource, text(pick(source, "id"), `observer-${index + 1}`), startSec, endSec, {
      previous: previousPose,
      baseline: stage.observerPose,
      continuous: cueContinuous,
      durationSec: endSec - startSec,
    });
    cues.push(cue);
    previousPose = cue.end;
    previousEnd = endSec;
  }
  return cues;
}

export type ParseStageScoreResult = {score: StageScore | null; error?: string; diagnostics: YamlDiagnostic[]};

/** Parse a score. A broken document reports one error and keeps every warning it can. */
export function parseStageScore(source: string): ParseStageScoreResult {
  const read = parseYaml(source);
  const diagnostics = [...read.diagnostics];
  const error = diagnostics.find((entry) => entry.severity === "error");
  if (error || !isDict(read.value)) {
    return {score: null, error: error?.message ?? "The score must be a YAML mapping.", diagnostics};
  }
  const warnings: YamlDiagnostic[] = [];
  const root = read.value;
  const stageSource = dict(pick(root, "stage"));
  const stage = {
    width: Math.max(1, numberAt(pick(stageSource, "width"), 10)),
    depth: Math.max(1, numberAt(pick(stageSource, "depth"), 10)),
    gridStep: Math.max(0.1, numberAt(pick(stageSource, "grid_step", "gridStep"), 1)),
    observerPose: baselinePose(dict(pick(stageSource, "observer_camera", "observerCamera")), DEFAULT_OBSERVER_POSE),
    stagePose: baselinePose(dict(pick(stageSource, "stage_camera", "stageCamera")), DEFAULT_STAGE_POSE),
  };
  const entities = list(pick(root, "entities"))
    .map((entry, index) => defaultEntity(dict(entry), index, warnings))
    .filter((entity): entity is SceneEntity => !!entity);
  const uniqueEntities = new Map<string, SceneEntity>();
  for (const entity of entities) {
    if (uniqueEntities.has(entity.id)) warnings.push({line: 0, message: `Entity id "${entity.id}" appears twice; the first one is used.`, severity: "warning"});
    else uniqueEntities.set(entity.id, entity);
  }
  const rootContinuous = flag(pick(root, "continuous"), false);
  const shots: Shot[] = [];
  const shotEntries = list(pick(root, "shots", "score"));
  for (let index = 0; index < shotEntries.length; index++) {
    shots.push(normalizeShot(shotEntries[index], index, {rootContinuous, previousShot: shots[index - 1] ?? null, stage, warnings}));
  }
  if (!shots.length) warnings.push({line: 0, message: "The score has no shots; the baseline stage camera is used.", severity: "warning"});
  const blocking = list(pick(root, "blocking")).length ? blockingCues(list(pick(root, "blocking")), rootContinuous, warnings, uniqueEntities) : undefined;
  const observerShots = list(pick(root, "observer_shots", "observerShots")).length ? observerCues(list(pick(root, "observer_shots", "observerShots")), stage, rootContinuous) : undefined;
  const videoSource = pick(root, "video", "video_url", "videoUrl");
  const videoUrl = isDict(videoSource) ? text(pick(videoSource, "src", "url"), "") : text(videoSource, "");
  const opticsSource = dict(pick(root, "optics"));
  const opticsDof = text(pick(opticsSource, "dof", "default_dof"), "").trim().toLowerCase();
  const rootDof = text(pick(root, "dof", "depth_of_field", "depthOfField"), "").trim().toLowerCase();
  const dofName = opticsDof || rootDof;
  const optics = Object.keys(opticsSource).length || rootDof
    ? {
        dofBlur: flag(pick(opticsSource, "dof_blur", "dofBlur", "blur") ?? pick(root, "dof_blur", "dofBlur", "blur"), false),
        defaultDof: dofName === "shallow" || dofName === "medium" || dofName === "deep" ? (dofName as DofPreset) : undefined,
        defaultAperture: optionalNumber(pick(opticsSource, "aperture", "f_stop")),
      }
    : undefined;
  const explicitDuration = optionalNumber(pick(root, "duration", "durationSec"));
  const ends = [
    ...shots.map((shot) => shot.endSec),
    ...(blocking ?? []).map((cue) => cue.endSec),
    ...(observerShots ?? []).map((cue) => cue.endSec),
  ];
  const durationSec = Math.max(0.1, explicitDuration ?? (ends.length ? Math.max(...ends) : DEFAULT_DURATION_SEC));
  const aspectValue = pick(root, "aspect_ratio", "aspectRatio");
  const score: StageScore = {
    version: text(pick(root, "version"), "1.0"),
    id: text(pick(root, "id"), "custom-scene"),
    title: text(pick(root, "title"), "Untitled scene"),
    subtitle: pick(root, "subtitle") === undefined ? undefined : text(pick(root, "subtitle"), ""),
    description: pick(root, "description", "notes") === undefined ? undefined : text(pick(root, "description", "notes"), ""),
    metadata: isDict(pick(root, "metadata")) ? dict(pick(root, "metadata")) : undefined,
    continuous: rootContinuous,
    videoUrl,
    aspectRatio: aspect(aspectValue),
    durationSec,
    offsetSec: numberAt(pick(root, "offset", "offsetSec"), 0),
    stage: {
      ...stage,
      showRigs: flag(pick(stageSource, "show_rigs", "showRigs") ?? pick(root, "show_rigs", "showRigs"), true),
    },
    entities: [...uniqueEntities.values()],
    shots,
    blocking,
    observerShots,
    optics,
    warnings: [...read.diagnostics, ...warnings],
  };
  return {score, diagnostics: score.warnings};
}

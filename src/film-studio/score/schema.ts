/*
 * The data model of a StageFlow-style choreography score, normalized for the
 * runtime. Human-authored YAML in degrees and millimetres becomes radians and
 * metres here; the evaluator only ever sees this shape.
 *
 * The field set follows StageFlow's own AST contract (authoring manual sections
 * 3–6 and technical specification section 7) so scores travel between the two
 * tools unchanged.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | {[key: string]: YamlValue};

export type YamlDiagnostic = {line: number; message: string; severity: "error" | "warning"};

export type Vec3 = [number, number, number];

export type Easing = "smooth" | "linear" | "ease-in" | "ease-out" | "expo" | "pop" | "cruise" | "accel" | "deccel";

export type Maneuver = "cut" | "dolly" | "arc" | "swoop" | "orbit" | "sweep" | "spiral" | "dive" | "recoil" | "spline";

export type Direction = "cw" | "ccw";

export type EntityKind = "character" | "prop" | "marker";

export type EntityShape = "box" | "sphere" | "cylinder" | "capsule" | "x" | "t" | "circle" | "puck";

export type EntityStyle = "mannequin" | "edges" | "silhouette" | "wireframe" | "glass" | "solid" | "tape" | "glow" | "beacon";

export type DofPreset = "shallow" | "medium" | "deep";

/** A look-at point: an entity, a centroid of entities, the stage preset, or a world coordinate. */
export type TargetAnchor =
  | {kind: "point"; point: Vec3}
  | {kind: "entity"; id: string}
  | {kind: "centroid"; ids: string[]}
  | {kind: "stage"};

/** A spherical camera pose: target, radial distance, pitch, yaw, roll, prime lens. Angles are radians. */
export type CameraPose = {
  target: TargetAnchor;
  targetOffset: Vec3;
  distance: number;
  pitch: number;
  yaw: number;
  roll: number;
  lensMm: number;
};

export type FocusAnchor = {kind: "distance"; meters: number} | {kind: "anchor"; anchor: TargetAnchor};

/** One resolved camera cue: start and end poses, the path between them and the lens behaviour. */
export type CameraCue = {
  id: string;
  startSec: number;
  endSec: number;
  continuous: boolean;
  maneuver: Maneuver;
  easing: Easing;
  start: CameraPose;
  end: CameraPose;
  /** Orbit, sweep and spiral: total azimuth travel resolved from the shot duration. */
  yawDelta: number;
  breathe: number;
  waypoints: CameraPose[];
  focus?: FocusAnchor;
  focusStart?: FocusAnchor;
  focusEnd?: FocusAnchor;
  dof?: DofPreset;
  aperture?: number;
  apertureStart?: number;
  apertureEnd?: number;
};

export type EntityOverride = {
  cut?: boolean;
  from?: Vec3;
  position?: Vec3;
  rotation?: number;
  lookAt?: TargetAnchor;
  easing: Easing;
  highlighted?: boolean;
  visible?: boolean;
  fromSize?: {width: number; height: number; depth: number};
  size?: {width: number; height: number; depth: number};
};

export type Shot = {
  id: string;
  shotNumber: number;
  label: string;
  description: string;
  startSec: number;
  endSec: number;
  continuous: boolean;
  camera: CameraCue | null;
  observerCamera: CameraCue | null;
  overrides: Record<string, EntityOverride>;
};

export type Dimensions = {width: number; height: number; depth: number};

export type BlockingCue = {
  id: string;
  label?: string;
  entityId: string;
  startSec: number;
  endSec: number;
  fromPosition: Vec3;
  position: Vec3;
  fromSize: Dimensions;
  size: Dimensions;
  rotation?: number;
  lookAt?: TargetAnchor;
  easing: Easing;
  cut: boolean;
  visible?: boolean;
  highlighted?: boolean;
  note?: string;
  continuous: boolean;
};

export type SceneEntity = {
  id: string;
  label: string;
  kind: EntityKind;
  shape?: EntityShape;
  style: EntityStyle;
  position: Vec3;
  rotation: number;
  height: number;
  width: number;
  depth: number;
  radius: number;
  color: string;
};

export type StageGeometry = {
  width: number;
  depth: number;
  gridStep: number;
  showRigs: boolean;
  observerPose: CameraPose;
  stagePose: CameraPose;
};

export type ScoreOptics = {dofBlur: boolean; defaultDof?: DofPreset; defaultAperture?: number};

/** A parsed, normalized choreography score. Evaluation is a pure function of this and a time. */
export type StageScore = {
  version: string;
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  metadata?: Record<string, YamlValue>;
  continuous: boolean;
  videoUrl: string;
  aspectRatio: number;
  durationSec: number;
  offsetSec: number;
  stage: StageGeometry;
  entities: SceneEntity[];
  shots: Shot[];
  blocking?: BlockingCue[];
  observerShots?: CameraCue[];
  optics?: ScoreOptics;
  warnings: YamlDiagnostic[];
};

/** 3D state of one entity at the evaluated time. */
export type EvaluatedEntity = {
  id: string;
  def: SceneEntity;
  position: Vec3;
  rotation: number;
  size: Dimensions;
  visible: boolean;
  highlighted: boolean;
  /** The 16-segment ground trail of the active blocking cue, empty during holds. */
  trailPoints: Vec3[];
};

/** 3D state of one camera at the evaluated time, in world space. */
export type EvaluatedCamera = {
  eye: Vec3;
  target: Vec3;
  up: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  distance: number;
  lensMm: number;
  /** Vertical field of view in degrees. */
  fovDeg: number;
  focusDistanceM?: number;
  dofNearM?: number;
  dofFarM?: number;
};

/** Everything the viewport needs for one instant. */
export type StageFrame = {
  timeSec: number;
  entities: EvaluatedEntity[];
  stageCamera: EvaluatedCamera;
  observerCamera: EvaluatedCamera;
  activeShotIndex: number;
  activeShot: Shot | null;
  shotCount: number;
};

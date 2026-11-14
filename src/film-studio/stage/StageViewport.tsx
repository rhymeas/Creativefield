/*
 * The diorama viewport: grey-block people, props and floor marks, the active
 * film camera with its gate frustum, movement trails and labels.
 *
 * Plain three.js (the app already ships it for model previews), so no new
 * library is needed. The camera renders the decoupled observer timeline
 * ("Scripted"), a free orbit around the stage, or the active film camera
 * ("Film cam"). All geometry comes from the evaluated frame.
 */
import {forwardRef, useEffect, useImperativeHandle, useMemo, useRef} from "react";
import {
  AmbientLight,
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  BoxGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RingGeometry,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Camera,
  type Object3D,
} from "three";
import type {EvaluatedCamera, EvaluatedEntity, StageFrame, StageScore} from "../score/schema";
import type {SceneBlock} from "../analysis-contract";
import {sceneBlockMeshes} from "./scene-blocks";
import {buildMannequin, STRIDE_PER_CYCLE_M, type Mannequin, type WalkState} from "./mannequin";
import {evaluateFrame} from "../score/evaluate";

export type ViewMode = "scripted" | "free" | "stage";
export type LabelMode = "all" | "cam" | "off";

/** Framing presets for Free orbit: fit what is on stage now, or look at it from a fixed side. */
export type FramePreset = "fit" | "top" | "front" | "side" | "iso";

export type StageViewportHandle = {
  capturePng: () => Promise<Blob>;
  /** Put the free orbit camera on a preset that frames the visible cast, props and marks. The caller
   *  switches the view to Free orbit; the pose set here survives that switch. */
  frame: (preset: FramePreset) => void;
};

const PRESET_ANGLES: Record<FramePreset, {azimuth?: number; elevation: number}> = {
  fit: {elevation: 0.45},
  top: {azimuth: 0, elevation: 1.5},
  front: {azimuth: 0, elevation: 0.12},
  side: {azimuth: Math.PI / 2, elevation: 0.12},
  iso: {azimuth: Math.PI / 4, elevation: 0.62},
};

type Props = {
  score: StageScore;
  frame: StageFrame;
  view: ViewMode;
  labels: LabelMode;
  /** The active shot's grey scene blocks from the reference analysis (render-only overlay). */
  setBlocks?: readonly SceneBlock[];
  /** Called when a drag starts in a locked view: the studio pauses and hands over to Free orbit. */
  onNavigateStart: () => void;
};

export type EntityVisual = {group: Group; label: Sprite; trail: Line; ring: Mesh; body?: Mesh; parts: Mesh[]; baseHeight: number; mannequin?: Mannequin};
export type BuiltScene = {
  scene: Scene;
  entities: Map<string, EntityVisual>;
  /** Grey analysis set of the active shot; rebuilt when the shot or its blocks change. */
  setGroup: Group;
  setKey: string;
  cameraRig: Group;
  frustum: LineSegments;
  cameraLabelSlot: Group;
  cameraLabel: Sprite;
  relabelCamera: (text: string) => void;
  dispose: () => void;
};

const LABEL_TEXT = (text: string) => text;

/** A small pill label (dot in the entity's colour, light text) drawn on a canvas. It keeps one size on
 *  screen whatever the distance (sizeAttenuation off), like the reference studio, so labels never swamp the stage. */
function makeLabel(text: string, color: string): Sprite {
  const fontSize = 30;
  const padding = 14;
  const dot = 9;
  const font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
  const measure = document.createElement("canvas").getContext("2d");
  if (measure) measure.font = font;
  const textWidth = measure?.measureText(text).width ?? text.length * fontSize * 0.55;
  const height = fontSize + padding;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(8, Math.ceil(textWidth + padding * 2 + dot * 2 + 10));
  canvas.height = Math.ceil(height);
  const context = canvas.getContext("2d");
  if (context) {
    const radius = height / 2;
    context.fillStyle = "rgba(9, 11, 13, 0.86)";
    context.beginPath();
    context.roundRect(0, 0, canvas.width, canvas.height, radius);
    context.fill();
    context.globalAlpha = 0.45;
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    context.roundRect(1, 1, canvas.width - 2, canvas.height - 2, radius);
    context.stroke();
    context.globalAlpha = 1;
    context.fillStyle = color;
    context.beginPath();
    context.arc(padding + dot, canvas.height / 2, dot, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#e8eaed";
    context.font = font;
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText(text, padding + dot * 2 + 10, canvas.height / 2 + 1);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({map: texture, transparent: true, depthTest: false, sizeAttenuation: false}));
  // Screen units: about 3 % of the view height at the 40° observer lens.
  const screenHeight = 0.022;
  sprite.scale.set((canvas.width / canvas.height) * screenHeight, screenHeight, 1);
  sprite.renderOrder = 10;
  return sprite;
}

const colorOf = (entity: {color: string}) => new Color(entity.color);

function bodyMaterial(entity: EvaluatedEntity): MeshStandardMaterial {
  const style = entity.def.style;
  const opacity = style === "solid" ? 0.9 : style === "glass" ? 0.42 : style === "wireframe" ? 0.08 : 0.38;
  return new MeshStandardMaterial({color: colorOf(entity.def), roughness: 0.72, metalness: 0.02, transparent: true, opacity, side: DoubleSide, depthWrite: false});
}

/**
 * One character: the articulated mannequin at the person's measured height, dressed in
 * the entity's body material with darker joints and the white eye visor facing +Z.
 */
function buildCharacter(entity: EvaluatedEntity): {group: Group; mannequin: Mannequin} {
  const group = new Group();
  const body = bodyMaterial(entity);
  const joint = body.clone();
  joint.color.multiplyScalar(0.55);
  const mannequin = buildMannequin(Math.max(0.3, entity.size.height), {body, joint, visor: new MeshBasicMaterial({color: 0xffffff})});
  group.add(mannequin.rig.root);
  return {group, mannequin};
}

/** A prop from its authored shape; the body mesh is rescaled live for blocking posture cues. */
function buildProp(entity: EvaluatedEntity): Group {
  const group = new Group();
  const {width, height, depth} = entity.size;
  const shape = entity.def.shape ?? "box";
  const geometry =
    shape === "sphere"
      ? new SphereGeometry(Math.max(0.05, height / 2), 18, 14)
      : shape === "cylinder"
        ? new CylinderGeometry(Math.max(0.05, width / 2), Math.max(0.05, depth / 2), Math.max(0.05, height), 24)
        : shape === "capsule"
          ? new CapsuleGeometry(Math.max(0.05, width / 2), Math.max(0.05, height - width), 6, 14)
          : new BoxGeometry(Math.max(0.05, width), Math.max(0.05, height), Math.max(0.05, depth));
  const body = new Mesh(geometry, bodyMaterial(entity));
  body.position.y = height / 2;
  body.userData.body = true;
  group.add(body);
  if (entity.def.style === "wireframe" || entity.def.style === "edges") {
    const edges = new LineSegments(new BufferGeometry(), new LineBasicMaterial({color: colorOf(entity.def), transparent: true, opacity: 0.9}));
    edges.userData.decor = true;
    group.add(edges);
  }
  return group;
}

/** A floor mark: tape ring, T, cross or puck, with optional glow halo and a beacon pin. */
function buildMarker(entity: EvaluatedEntity): Group {
  const group = new Group();
  const width = Math.max(0.1, entity.size.width);
  const depth = Math.max(0.1, entity.size.depth);
  const radius = Math.max(0.08, Math.max(width, depth) / 2);
  const shape = entity.def.shape ?? "x";
  const style = entity.def.style;
  const tape = new MeshBasicMaterial({color: colorOf(entity.def), transparent: true, opacity: 0.72, side: DoubleSide, depthWrite: false});
  if (shape === "circle" || shape === "puck") {
    const ring = new Mesh(new RingGeometry(radius * 0.82, radius, 32), tape);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.005;
    group.add(ring);
  } else if (shape === "t") {
    const bar = new Mesh(new BoxGeometry(radius * 1.6, 0.012, radius * 0.28), tape);
    bar.position.y = 0.006;
    group.add(bar);
    const stem = new Mesh(new BoxGeometry(radius * 0.28, 0.012, radius * 1.2), tape);
    stem.position.y = 0.006;
    group.add(stem);
  } else {
    for (let index = 0; index < 2; index++) {
      const bar = new Mesh(new BoxGeometry(radius * 1.7, 0.012, radius * 0.24), tape);
      bar.position.y = 0.006;
      bar.rotation.y = index === 0 ? Math.PI / 4 : -Math.PI / 4;
      group.add(bar);
    }
  }
  if (style === "glow" || style === "beacon") {
    const halo = new Mesh(new RingGeometry(radius * 1.1, radius * 1.35, 40), new MeshBasicMaterial({color: colorOf(entity.def), transparent: true, opacity: 0.32, side: DoubleSide, depthWrite: false}));
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.003;
    group.add(halo);
  }
  if (style === "beacon") {
    const pin = new Mesh(new CylinderGeometry(0.012, 0.012, 0.44, 8), new MeshBasicMaterial({color: colorOf(entity.def)}));
    pin.position.y = 0.22;
    group.add(pin);
    const tip = new Mesh(new SphereGeometry(0.035, 12, 10), new MeshBasicMaterial({color: colorOf(entity.def)}));
    tip.position.y = 0.44;
    group.add(tip);
  }
  return group;
}

function buildGrid(score: StageScore): Group {
  const group = new Group();
  group.name = "stage-grid";
  const {width, depth, gridStep} = score.stage;
  const halfX = width / 2;
  const halfZ = depth / 2;
  const positions: number[] = [];
  const stepX = Math.max(0.1, gridStep);
  const stepZ = Math.max(0.1, gridStep);
  for (let x = -halfX; x <= halfX + 0.0001; x += stepX) positions.push(x, 0, -halfZ, x, 0, halfZ);
  for (let z = -halfZ; z <= halfZ + 0.0001; z += stepZ) positions.push(-halfX, 0, z, halfX, 0, z);
  const grid = new LineSegments(new BufferGeometry().setAttribute("position", new Float32BufferAttribute(positions, 3)), new LineBasicMaterial({color: 0x8a9096, transparent: true, opacity: 0.28}));
  group.add(grid);
  const floor = new Mesh(new PlaneGeometry(width, depth), new MeshStandardMaterial({color: 0x2a2e33, transparent: true, opacity: 0.35, roughness: 1, metalness: 0, depthWrite: false}));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.003;
  group.add(floor);
  const outline: number[] = [];
  const corners: Array<[number, number]> = [[-halfX, -halfZ], [halfX, -halfZ], [halfX, halfZ], [-halfX, halfZ]];
  for (let index = 0; index < 4; index++) {
    const [x1, z1] = corners[index];
    const [x2, z2] = corners[(index + 1) % 4];
    outline.push(x1, 0.002, z1, x2, 0.002, z2);
  }
  group.add(new LineSegments(new BufferGeometry().setAttribute("position", new Float32BufferAttribute(outline, 3)), new LineBasicMaterial({color: 0x9aa1a8, transparent: true, opacity: 0.55})));
  return group;
}

function disposeObject(object: Object3D) {
  object.traverse((node) => {
    const mesh = node as Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as MeshStandardMaterial | MeshBasicMaterial | LineBasicMaterial | SpriteMaterial | undefined;
    if (!material) return;
    if ((material as SpriteMaterial).map) (material as SpriteMaterial).map?.dispose();
    material.dispose();
  });
}

export function buildStageScene(score: StageScore): BuiltScene {
  const scene = new Scene();
  scene.add(new AmbientLight(0xffffff, 1.3));
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(4, 8, 6);
  scene.add(key);
  const fill = new DirectionalLight(0xffffff, 0.7);
  fill.position.set(-6, 3, -4);
  scene.add(fill);
  scene.add(buildGrid(score));
  // The analysis set is a render-only overlay: grey boxes of the active shot's measured room.
  const setGroup = new Group();
  setGroup.name = "analysis-set";
  scene.add(setGroup);
  const entities = new Map<string, EntityVisual>();
  for (const entity of score.entities) {
    const sameEntity: EvaluatedEntity = {
      id: entity.id,
      def: entity,
      position: entity.position,
      rotation: entity.rotation,
      size: {width: entity.width, height: entity.height, depth: entity.depth},
      visible: true,
      highlighted: false,
      trailPoints: [],
    };
    const group = new Group();
    group.name = entity.id;
    const character = entity.kind === "character" ? buildCharacter(sameEntity) : undefined;
    group.add(character ? character.group : entity.kind === "marker" ? buildMarker(sameEntity) : buildProp(sameEntity));
    const label = makeLabel(LABEL_TEXT(entity.label), entity.color);
    label.position.y = (entity.kind === "character" ? entity.height : entity.kind === "marker" ? 0.4 : entity.height) + 0.3;
    group.add(label);
    const ring = new Mesh(new RingGeometry(Math.max(0.3, entity.width * 0.8), Math.max(0.36, entity.width * 0.8) + 0.05, 40), new MeshBasicMaterial({color: colorOf(entity), transparent: true, opacity: 0, side: DoubleSide, depthWrite: false}));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.004;
    group.add(ring);
    scene.add(group);
    const trail = new Line(new BufferGeometry(), new LineDashedMaterial({color: colorOf(entity), transparent: true, opacity: 0.85, dashSize: 0.18, gapSize: 0.12}));
    trail.visible = false;
    scene.add(trail);
    entities.set(entity.id, {
      group,
      label,
      trail,
      ring,
      body: group.children.find((child) => (child as Mesh & {userData: {body?: boolean}}).userData.body) as Mesh | undefined,
      parts: group.children.filter((child) => (child as Mesh & {userData: {part?: string}}).userData.part) as Mesh[],
      baseHeight: entity.kind === "character" ? 1.75 : entity.height,
      mannequin: character?.mannequin,
    });
  }
  const cameraRig = new Group();
  const body = new Mesh(new BoxGeometry(0.24, 0.18, 0.32), new MeshStandardMaterial({color: 0xfbbf24, roughness: 0.5, metalness: 0.3}));
  cameraRig.add(body);
  const lens = new Mesh(new CylinderGeometry(0.07, 0.09, 0.18, 16), new MeshStandardMaterial({color: 0x1c1e20, roughness: 0.4, metalness: 0.4}));
  lens.rotation.x = Math.PI / 2;
  lens.position.z = 0.24;
  cameraRig.add(lens);
  const frustum = new LineSegments(new BufferGeometry(), new LineBasicMaterial({color: 0xfbbf24, transparent: true, opacity: 0.5}));
  scene.add(frustum);
  const cameraLabelSlot = new Group();
  scene.add(cameraLabelSlot);
  let cameraLabel = makeLabel("FILM CAM", "#fbbf24");
  cameraLabelSlot.add(cameraLabel);
  scene.add(cameraRig);
  let lastText = "FILM CAM";
  const relabelCamera = (text: string) => {
    if (text === lastText) return;
    lastText = text;
    cameraLabelSlot.remove(cameraLabel);
    cameraLabel.material.map?.dispose();
    cameraLabel.material.dispose();
    cameraLabel = makeLabel(text, "#fbbf24");
    cameraLabelSlot.add(cameraLabel);
  };
  return {
    scene,
    entities,
    setGroup,
    setKey: "",
    cameraRig,
    frustum,
    cameraLabelSlot,
    get cameraLabel() {
      return cameraLabel;
    },
    relabelCamera,
    dispose: () => disposeObject(scene),
  };
}

/**
 * Draw the active shot's grey analysis set. Blocks are an overlay from the reference
 * geometry, not part of the score: they are rebuilt only when the shot's blocks change,
 * and the previous meshes (geometry + material) are disposed. A shot without blocks
 * (older cache) clears the group.
 */
export function applySceneSet(built: BuiltScene, blocks: readonly SceneBlock[] | undefined) {
  const meshes = sceneBlockMeshes(blocks);
  const key = meshes.map((mesh) => `${mesh.position.join(",")}|${mesh.size.join(",")}|${mesh.shade}`).join(";");
  if (key === built.setKey) return;
  built.setKey = key;
  for (const child of [...built.setGroup.children]) {
    built.setGroup.remove(child);
    disposeObject(child);
  }
  for (const entry of meshes) {
    const material = new MeshStandardMaterial({color: entry.shade, roughness: 0.96, metalness: 0});
    const mesh = new Mesh(new BoxGeometry(entry.size[0], entry.size[1], entry.size[2]), material);
    mesh.position.set(entry.position[0], entry.position[1], entry.position[2]);
    built.setGroup.add(mesh);
  }
}

/** Turn an evaluated camera into a three camera. */
export function applyCamera(camera: PerspectiveCamera, source: EvaluatedCamera, aspect: number) {
  camera.position.set(...source.eye);
  camera.up.set(...source.up);
  camera.lookAt(new Vector3(...source.target));
  camera.fov = source.fovDeg;
  camera.aspect = aspect;
  camera.near = 0.05;
  camera.far = 500;
  camera.updateProjectionMatrix();
}

export type SceneFrameOptions = {
  /** Which label groups are on: entity labels only with "all", the camera label also with "cam". */
  labels: LabelMode;
  /** Draw the film camera body, gate frustum and its label (off for clean shot stills). */
  showCameraRig: boolean;
};

/**
 * Write one evaluated frame onto the diorama scene graph. Shared by the live
 * viewport, the shot thumbnails and the clip recorder so all three render the
 * same staging.
 */
/** Seconds back to the frame a walk speed is measured against. */
const WALK_PROBE_SEC = 0.1;

/**
 * The walk of a character at this instant, without state: its speed from the score 0.1 s earlier,
 * and a stride phase from its position along the direction it travels. Scrubbing, stills and the
 * clip recorder therefore show the same step at the same time, and a figure the camera follows is
 * seen walking instead of standing on a sliding floor.
 */
function walkOf(entity: EvaluatedEntity, previous: EvaluatedEntity | undefined, rigHeight: number): WalkState {
  if (!previous) return {phase: 0, amount: 0};
  const dx = entity.position[0] - previous.position[0];
  const dz = entity.position[2] - previous.position[2];
  const step = Math.hypot(dx, dz);
  // A cut teleports a figure; a jump of more than 1.5 m in 0.1 s is not a walk.
  if (step > 1.5) return {phase: 0, amount: 0};
  const speed = step / WALK_PROBE_SEC;
  const amount = Math.max(0, Math.min(1, (speed - 0.15) / 0.75));
  if (amount === 0) return {phase: 0, amount: 0};
  const travelled = (entity.position[0] * dx + entity.position[2] * dz) / step;
  const cycle = STRIDE_PER_CYCLE_M * (rigHeight / 1.7);
  // A figure that looks one way and travels the other (walk and talk) steps backward: the stride
  // phase runs against the body's forward axis, so the swing foot moves the way the body goes.
  const along = (dx * Math.sin(entity.rotation) + dz * Math.cos(entity.rotation)) / step;
  return {phase: ((along < 0 ? -1 : 1) * 2 * Math.PI * travelled) / cycle, amount};
}

export function applyStageFrame(built: BuiltScene, score: StageScore, frame: StageFrame, options: SceneFrameOptions) {
  const earlier = frame.timeSec > WALK_PROBE_SEC ? new Map(evaluateFrame(score, frame.timeSec - WALK_PROBE_SEC - score.offsetSec).entities.map((item) => [item.id, item])) : new Map<string, EvaluatedEntity>();
  for (const entity of frame.entities) {
    const visual = built.entities.get(entity.id);
    if (!visual) continue;
    visual.group.visible = entity.visible;
    visual.group.position.set(entity.position[0], entity.position[1], entity.position[2]);
    visual.group.rotation.y = entity.rotation;
    if (entity.def.kind !== "marker" && visual.body) {
      visual.body.scale.set(
        Math.max(0.05, entity.size.width / Math.max(0.05, entity.def.width)),
        Math.max(0.05, entity.size.height / Math.max(0.05, entity.def.height)),
        Math.max(0.05, entity.size.depth / Math.max(0.05, entity.def.depth)),
      );
      visual.body.position.y = entity.size.height / 2;
    }
    if (visual.mannequin) {
      // A lower posture cue bends the knees instead of shrinking the body (the hip drop is in rig heights).
      // A figure that travels walks: its legs and arms follow the distance it covers.
      visual.mannequin.setPose(Math.max(0, entity.def.height - entity.size.height) / visual.mannequin.rig.height, walkOf(entity, earlier.get(entity.id), visual.mannequin.rig.height));
    }
    visual.label.visible = options.labels === "all";
    visual.label.position.y = (entity.def.kind === "character" ? entity.size.height : entity.def.kind === "marker" ? 0.4 : entity.size.height) + 0.3;
    visual.label.position.x = 0;
    visual.ring.visible = entity.highlighted;
    if (entity.highlighted) {
      (visual.ring.material as MeshBasicMaterial).opacity = 0.9;
      visual.ring.rotation.z += 0.002;
    }
    const showTrail = entity.trailPoints.length > 1;
    visual.trail.visible = showTrail;
    if (showTrail) {
      const points: number[] = [];
      for (const point of entity.trailPoints) points.push(point[0], point[1] + 0.012, point[2]);
      visual.trail.geometry.dispose();
      visual.trail.geometry = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(points, 3));
      visual.trail.computeLineDistances();
    }
  }
  const stage = frame.stageCamera;
  const eye = new Vector3(...stage.eye);
  const target = new Vector3(...stage.target);
  const up = new Vector3(...stage.up);
  built.cameraRig.visible = options.showCameraRig;
  built.frustum.visible = options.showCameraRig;
  built.cameraLabelSlot.visible = options.showCameraRig && options.labels !== "off";
  built.cameraRig.position.copy(eye);
  built.cameraRig.lookAt(target);
  const maneuver = frame.activeShot?.camera?.maneuver?.toUpperCase() ?? "CUT";
  built.relabelCamera(`CAM · ${Math.round(stage.lensMm)}mm · ${maneuver}`);
  built.cameraLabelSlot.position.copy(eye);
  built.cameraLabelSlot.position.y += 0.55;
  const distance = Math.max(0.2, stage.distance);
  const halfHeight = distance * Math.tan((stage.fovDeg * Math.PI) / 360);
  const halfWidth = halfHeight * score.aspectRatio;
  const forward = new Vector3().subVectors(target, eye).normalize();
  const right = new Vector3().crossVectors(forward, up).normalize();
  const realUp = new Vector3().crossVectors(right, forward).normalize();
  const corners = [
    new Vector3().copy(target).addScaledVector(right, halfWidth).addScaledVector(realUp, halfHeight),
    new Vector3().copy(target).addScaledVector(right, -halfWidth).addScaledVector(realUp, halfHeight),
    new Vector3().copy(target).addScaledVector(right, -halfWidth).addScaledVector(realUp, -halfHeight),
    new Vector3().copy(target).addScaledVector(right, halfWidth).addScaledVector(realUp, -halfHeight),
  ];
  const points: number[] = [];
  for (let index = 0; index < 4; index++) {
    const corner = corners[index];
    points.push(eye.x, eye.y, eye.z, corner.x, corner.y, corner.z);
    const next = corners[(index + 1) % 4];
    points.push(corner.x, corner.y, corner.z, next.x, next.y, next.z);
  }
  built.frustum.geometry.dispose();
  built.frustum.geometry = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(points, 3));
}

export const StageViewport = forwardRef<StageViewportHandle, Props>(function StageViewport({score, frame, view, labels, setBlocks, onNavigateStart}, ref) {
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<BuiltScene | null>(null);
  const latest = useRef({frame, view, labels, setBlocks, onNavigateStart});
  latest.current = {frame, view, labels, setBlocks, onNavigateStart};
  const free = useRef({azimuth: 0.7, elevation: 0.35, distance: 12, target: new Vector3(0, 1, 0), lastX: 0, lastY: 0});
  const drag = useRef<{mode: "orbit" | "pan"; lastX: number; lastY: number} | null>(null);
  const renderCamera = useRef(new PerspectiveCamera(40, 16 / 9, 0.05, 500));

  /** Start from the pose the locked view is showing, so the first drag does not jump. */
  const syncFreeFromObserver = () => {
    const observer = latest.current.frame.observerCamera;
    const target = new Vector3(...observer.target);
    const eye = new Vector3(...observer.eye);
    const offset = new Vector3().subVectors(eye, target);
    free.current.target.copy(target);
    free.current.distance = Math.max(1, offset.length());
    free.current.azimuth = Math.atan2(offset.x, offset.z);
    free.current.elevation = Math.asin(Math.max(-0.99, Math.min(0.99, offset.y / Math.max(0.001, offset.length()))));
  };

  const framed = useRef(false);
  useImperativeHandle(ref, () => ({
    frame: (preset: FramePreset) => {
      // The action is the cast; props count when nobody is on stage, floor marks when nothing else is.
      const shown = latest.current.frame.entities.filter((entity) => entity.visible);
      const cast = shown.filter((entity) => entity.def.kind === "character");
      const props = shown.filter((entity) => entity.def.kind === "prop");
      const visible = cast.length ? cast : props.length ? props : shown;
      const points = visible.length ? visible.map((entity) => new Vector3(...entity.position)) : [new Vector3(0, 0, 0)];
      const center = points.reduce((sum, point) => sum.add(point), new Vector3()).multiplyScalar(1 / points.length);
      const radius = Math.max(2, ...visible.map((entity) => new Vector3(...entity.position).distanceTo(center) + Math.max(entity.size.width, entity.size.depth, entity.size.height) / 2));
      center.y = Math.max(0.8, center.y + 0.9);
      const angles = PRESET_ANGLES[preset];
      const orbit = free.current;
      orbit.target.copy(center);
      // Fit the bounding sphere in the 40° vertical field with a little air around it.
      orbit.distance = Math.min(80, (radius * 1.1) / Math.sin((20 * Math.PI) / 180));
      orbit.elevation = angles.elevation;
      if (angles.azimuth !== undefined) orbit.azimuth = angles.azimuth;
      // Only skip the next "entering free orbit" sync when that switch is still to come.
      framed.current = latest.current.view !== "free";
    },
    capturePng: () =>
      new Promise<Blob>((resolve, reject) => {
        const element = canvas.current;
        if (!element) {
          reject(new Error("The viewport is not ready."));
          return;
        }
        element.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The frame could not be encoded."))), "image/png");
      }),
  }), []);

  // Build the scene graph once per parsed score.
  useEffect(() => {
    const element = canvas.current;
    const holder = container.current;
    if (!element || !holder) return;
    let disposed = false;
    const built = buildStageScene(score);
    const renderer = new WebGLRenderer({canvas: element, antialias: true, alpha: true, preserveDrawingBuffer: true});
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0x000000, 0);
    sceneRef.current?.dispose();
    sceneRef.current = built;
    // The canvas follows its holder (never its own last size, or it could never grow). Stage cam shows the
    // film gate itself: the canvas takes the score's aspect, letterboxed inside the stage.
    let sized = "";
    const resize = () => {
      const boxWidth = holder.clientWidth;
      const boxHeight = holder.clientHeight;
      if (!boxWidth || !boxHeight) return;
      let width = boxWidth;
      let height = boxHeight;
      if (latest.current.view === "stage") {
        const gate = score.aspectRatio || 16 / 9;
        if (boxWidth / boxHeight > gate) width = Math.round(boxHeight * gate);
        else height = Math.round(boxWidth / gate);
      }
      const key = `${width}x${height}`;
      if (key === sized) return;
      sized = key;
      renderer.setSize(width, height, false);
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
    };
    resize();
    const sizeObserver = new ResizeObserver(resize);
    sizeObserver.observe(holder);
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (disposed) return;
      const builtScene = sceneRef.current;
      if (!builtScene) return;
      resize();
      const state = latest.current;
      const width = element.clientWidth || 1;
      const height = element.clientHeight || 1;
      const aspect = width / height;
      applyStageFrame(builtScene, score, state.frame, {labels: state.labels, showCameraRig: state.view !== "stage"});
      applySceneSet(builtScene, state.setBlocks);
      const camera = renderCamera.current;
      if (state.view === "stage") {
        applyCamera(camera, state.frame.stageCamera, aspect);
      } else if (state.view === "free") {
        const orbit = free.current;
        const horizontal = orbit.distance * Math.cos(orbit.elevation);
        camera.position.set(
          orbit.target.x + horizontal * Math.sin(orbit.azimuth),
          orbit.target.y + orbit.distance * Math.sin(orbit.elevation),
          orbit.target.z + horizontal * Math.cos(orbit.azimuth),
        );
        camera.up.set(0, 1, 0);
        camera.lookAt(orbit.target);
        camera.fov = 40;
        camera.aspect = aspect;
        camera.near = 0.05;
        camera.far = 500;
        camera.updateProjectionMatrix();
      } else {
        applyCamera(camera, state.frame.observerCamera, aspect);
      }
      renderer.render(builtScene.scene, camera as Camera);
    };
    draw();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      sizeObserver.disconnect();
      sceneRef.current?.dispose();
      sceneRef.current = null;
      renderer.dispose();
    };
  }, [score]);

  // Entering free orbit starts from the current observer pose so the view does not jump.
  useEffect(() => {
    if (view !== "free") return;
    if (framed.current) {
      framed.current = false;
      return;
    }
    syncFreeFromObserver();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const handlers = useMemo(
    () => ({
      onContextMenu: (event: React.MouseEvent<HTMLCanvasElement>) => event.preventDefault(),
      onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => {
        event.preventDefault();
        const mode: "orbit" | "pan" = event.button === 1 || event.button === 2 || event.shiftKey ? "pan" : "orbit";
        if (latest.current.view !== "free") {
          syncFreeFromObserver();
          latest.current.onNavigateStart();
        }
        drag.current = {mode, lastX: event.clientX, lastY: event.clientY};
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => {
        const active = drag.current;
        if (!active) return;
        const dx = event.clientX - active.lastX;
        const dy = event.clientY - active.lastY;
        active.lastX = event.clientX;
        active.lastY = event.clientY;
        const orbit = free.current;
        if (active.mode === "orbit") {
          orbit.azimuth -= dx * 0.006;
          orbit.elevation = Math.max(-1.35, Math.min(1.35, orbit.elevation + dy * 0.005));
          return;
        }
        // Pan: move the pivot across the camera plane, the way a 3D viewport's middle mouse does.
        const forward = new Vector3(-Math.cos(orbit.elevation) * Math.sin(orbit.azimuth), -Math.sin(orbit.elevation), -Math.cos(orbit.elevation) * Math.cos(orbit.azimuth));
        const right = new Vector3().crossVectors(forward, new Vector3(0, 1, 0)).normalize();
        const up = new Vector3().crossVectors(right, forward).normalize();
        const scale = orbit.distance * 0.0018;
        orbit.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
      },
      onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      },
      onPointerCancel: (event: React.PointerEvent<HTMLCanvasElement>) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      },
    }),
    [],
  );

  // A native non-passive wheel listener: React's wheel handler is passive, so it cannot prevent page scroll.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (latest.current.view !== "free") {
        syncFreeFromObserver();
        latest.current.onNavigateStart();
      }
      free.current.distance = Math.max(1.5, Math.min(80, free.current.distance * (1 + event.deltaY * 0.0012)));
    };
    element.addEventListener("wheel", onWheel, {passive: false});
    return () => element.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fs-viewport" ref={container}>
      <canvas ref={canvas} className="fs-viewport__canvas" {...handlers} />
    </div>
  );
});

/**
 * Block a shot: a scene as plain data (props, a camera path, a lens), plus the camera and shading math.
 *
 * Ported from OpenField's Stage (wexloops/openfield, src/stage.ts, MIT License, Copyright (c) 2026
 * David Wexler / Strangeloop Studios). Kept: the scene model, the camera moves and Catmull-Rom path,
 * prop motion, the clay shading and the depth range. Dropped: the editor helpers (key insertion,
 * retiming), GLB props, render tiers and the LTX frame grid. Sizes and frame counts follow Wan VACE
 * (multiples of 16, 4n + 1 frames at 16 fps) instead.
 *
 * Units are metres. Y is up, the ground is y = 0, the camera looks down -Z by default.
 */
export type Vec3 = [number, number, number];
export type PropType = "box" | "cylinder" | "figure" | "wall" | "sphere";
export type StageProp = {
  id: string; type: PropType;
  /** Footprint centre at the start of the shot; y is the height of the base. */
  pos: Vec3;
  /** Where the footprint centre is at the end of the move. Absent = it stays put. */
  to?: Vec3;
  /** Width (x), height (y), depth (z) in metres, before rotation. */
  size: Vec3;
  /** Turn around the vertical axis, in degrees. */
  rot: number;
  label?: string;
};
export type CameraKey = { pos: Vec3; target: Vec3 };
export type StageAspect = "16:9" | "9:16" | "1:1";
export type StageScene = { v: 1; props: StageProp[]; keys: CameraKey[]; lens: number; aspect: StageAspect };

export const STAGE_FPS = 16;
/** Wan VACE lengths: 4n + 1 frames at 16 fps. */
export const STAGE_SECONDS = [2, 3, 4, 5] as const;
export const stageFrames = (seconds: number, fps: number = STAGE_FPS) => fps === STAGE_FPS ? Math.max(17, Math.round((seconds * STAGE_FPS - 1) / 4) * 4 + 1) : Math.round(seconds * fps);
/** Frame rates a layout can be drawn at: 16 for Wan VACE, 24 for MiniMax H3 (Grey-block to video). */
export const STAGE_RATES = [16, 24] as const;
/** Multiples of 16, around 480p. */
export const stageSize = (aspect: StageAspect): { w: number; h: number } => aspect === "16:9" ? { w: 832, h: 480 } : aspect === "9:16" ? { w: 480, h: 832 } : { w: 640, h: 640 };

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, mul(sub(b, a), t));
const round3 = (a: Vec3): Vec3 => a.map((x) => Math.round(x * 1000) / 1000) as Vec3;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// ---------- camera moves ----------

const pushIn = (k: CameraKey, amount = 0.5): CameraKey[] => [k, { pos: round3(lerp3(k.pos, k.target, amount)), target: k.target }];
const pullBack = (k: CameraKey, amount = 0.6): CameraKey[] => [k, { pos: round3(add(k.pos, mul(sub(k.pos, k.target), amount))), target: k.target }];
/** Swing around the target, `deg` degrees (+ = to the right), through a few keys so the path is an arc. */
const orbit = (k: CameraKey, deg = 40): CameraKey[] => {
  const off = sub(k.pos, k.target), out: CameraKey[] = [];
  for (let i = 0; i <= 4; i++) {
    const a = (deg * Math.PI / 180) * (i / 4), c = Math.cos(a), s = Math.sin(a);
    out.push({ pos: round3(add(k.target, [off[0] * c + off[2] * s, off[1], -off[0] * s + off[2] * c])), target: k.target });
  }
  return out;
};
/** Rise straight up, still looking at the subject, tilting down as it climbs. */
const crane = (k: CameraKey, rise = 2.6): CameraKey[] => [k, { pos: round3(add(k.pos, [0, rise, 0])), target: round3(add(k.target, [0, -0.3, 0])) }];
/** Slide sideways, camera and aim together. `side` -1 = left, 1 = right. */
const dolly = (k: CameraKey, side: -1 | 1, dist = 2.2): CameraKey[] => {
  const f = sub(k.target, k.pos), r = Math.hypot(f[0], f[2]) || 1, d = mul([-f[2] / r, 0, f[0] / r], side * dist);
  return [k, { pos: round3(add(k.pos, d)), target: round3(add(k.target, d)) }];
};

export const CAMERA_MOVES = [
  { id: "push-in", name: "Push in", make: (k: CameraKey) => pushIn(k) },
  { id: "pull-back", name: "Pull back", make: (k: CameraKey) => pullBack(k) },
  { id: "orbit-left", name: "Orbit left", make: (k: CameraKey) => orbit(k, -40) },
  { id: "orbit-right", name: "Orbit right", make: (k: CameraKey) => orbit(k, 40) },
  { id: "crane-up", name: "Crane up", make: (k: CameraKey) => crane(k) },
  { id: "dolly-left", name: "Dolly left", make: (k: CameraKey) => dolly(k, -1) },
  { id: "dolly-right", name: "Dolly right", make: (k: CameraKey) => dolly(k, 1) },
  { id: "static", name: "Locked off", make: (k: CameraKey) => [k, { pos: k.pos, target: k.target }] },
] as const;
export type CameraMoveId = (typeof CAMERA_MOVES)[number]["id"];
export const cameraMove = (id: string) => CAMERA_MOVES.find((m) => m.id === id);

/** Ease in and out, so a move starts and lands like a dolly grip would. */
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Uniform Catmull-Rom through p1..p2, with p0 / p3 as neighbours. */
function catmull(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t2 = t * t, t3 = t2 * t;
  return [0, 1, 2].map((i) => 0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3)) as Vec3;
}
/** A point on the path through `points`; x runs 0..points.length - 1 (key i at x = i). */
function along(points: Vec3[], x: number): Vec3 {
  if (points.length === 1) return points[0];
  if (points.length === 2) return lerp3(points[0], points[1], clamp01(x));
  x = Math.min(points.length - 1 - 1e-9, Math.max(0, x));
  const i = Math.floor(x), p = (k: number) => points[Math.max(0, Math.min(points.length - 1, k))];
  return catmull(p(i - 1), p(i), p(i + 1), p(i + 2), x - i);
}
/** Camera at shot time t (0..1), eased over the whole shot, keys spread evenly along the path. */
export function cameraAt(s: Pick<StageScene, "keys">, t: number): CameraKey {
  const n = s.keys.length, x = n > 1 ? smooth(clamp01(t)) * (n - 1) : 0;
  return { pos: along(s.keys.map((k) => k.pos), x), target: along(s.keys.map((k) => k.target), x) };
}

/** Where a prop's footprint is at shot time t. A moving prop goes at an even pace. */
export const propAt = (p: StageProp, t: number): Vec3 => (p.to ? lerp3(p.pos, p.to, clamp01(t)) : p.pos);

/** Vertical field of view in degrees: the long edge of the frame is 36 mm. */
export function verticalFov(lens: number, w: number, h: number): number {
  const half = 18 / Math.max(1, lens), vHalf = w >= h ? half * (h / w) : half;
  return (2 * Math.atan(vHalf) * 180) / Math.PI;
}

// ---------- clay and depth ----------

export const CLAY = {
  background: [0.11, 0.11, 0.115] as Vec3, albedo: 0.64, ground: 0.44,
  /** Ground checker: 2 m tiles, this much brighter / darker. */
  checker: 0.045, tile: 2, ambient: 0.34,
  key: { dir: [0.75, 0.7, 0.45] as Vec3, strength: 0.66 }, fill: { dir: [-0.7, 0.3, 0.3] as Vec3, strength: 0.14 },
};
const unit = (v: Vec3): Vec3 => mul(v, 1 / (len(v) || 1));
const KEY_DIR = unit(CLAY.key.dir), FILL_DIR = unit(CLAY.fill.dir);
/** The clay grey at a surface point with unit normal n (facing the camera). The ground gets a soft 2 m checker so a camera move reads against it. */
export function clayGrey(nx: number, ny: number, nz: number, wx: number, wz: number, ground: boolean): number {
  let albedo = CLAY.albedo;
  if (ground) albedo = CLAY.ground + (((Math.floor(wx / CLAY.tile) + Math.floor(wz / CLAY.tile)) & 1) ? CLAY.checker : -CLAY.checker);
  const k = Math.max(0, nx * KEY_DIR[0] + ny * KEY_DIR[1] + nz * KEY_DIR[2]), f = Math.max(0, nx * FILL_DIR[0] + ny * FILL_DIR[1] + nz * FILL_DIR[2]);
  return Math.min(1, albedo * (CLAY.ambient + CLAY.key.strength * k + CLAY.fill.strength * f) * 1.25);
}

/** Depth pass range: white at NEAR metres, black at `far` and beyond. */
export const DEPTH_NEAR = 0.3;
/** A far plane that spends the depth range on the set, not on empty ground. */
export function depthFar(s: StageScene): number {
  let far = 8;
  for (const t of [0, 0.5, 1]) {
    const cam = cameraAt(s, t).pos;
    for (const p of s.props) far = Math.max(far, len(sub(propAt(p, t), cam)) + Math.hypot(p.size[0], p.size[2]) / 2);
  }
  return Math.min(80, far * 1.35);
}
/** Linear depth to a grey value in 0..1. */
export const depthValue = (viewZ: number, far: number) => Math.max(0, Math.min(1, 1 - (viewZ - DEPTH_NEAR) / (far - DEPTH_NEAR)));

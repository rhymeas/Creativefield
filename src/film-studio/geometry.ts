/*
 * Pure monocular-geometry math for the film studio's analysis stage.
 *
 * Input is the metric point cloud MoGe-2 wrote into a GLB, in OpenCV camera
 * space: +X right, +Y down, +Z forward, metres. Everything here is deterministic
 * (seeded RANSAC, least squares) and DOM/Node free, so the team server imports it
 * unchanged and test/geometry.test.ts can feed it synthetic camera scenes.
 *
 * Output conventions are the analysis contract's (see analysis-contract.ts):
 * - The floor plane is stored as a unit normal pointing away from the floor (up)
 *   plus offsetM, with the camera at the origin; camera height = offsetM.
 * - pitchDeg is positive when the real camera looks down.
 * - Positions are camera-relative metres on the floor: +xM right, +zM forward
 *   along the camera's optical axis, so a person in front of the camera has a
 *   positive zM and a person to the right a positive xM.
 */
import {lensMmFromHorizontalFov, type GeometryFloor, type SceneBlock} from "./analysis-contract";

export type Vec3 = [number, number, number];

export type CameraIntrinsics = {
  /** Focal length in pixels on the x axis, at `width`. */
  fxPx: number;
  /** Focal length in pixels on the y axis, at `height`. */
  fyPx: number;
  width: number;
  height: number;
};

/** The measured floor plane in camera coordinates (normal points up, away from the floor). */
export type FloorPlane = {
  normal: Vec3;
  /** Distance from the camera to the plane in metres (= camera height). */
  offsetM: number;
  inliers: number;
  /** Inlier ratio of the candidate point cloud, 0..1. */
  confidence: number;
  candidateCount: number;
  rmsM: number;
};

export type FloorOptions = {
  /** Inlier band around the plane in metres. */
  maxDistanceM?: number;
  iterations?: number;
  seed?: number;
  /** Reject a fit with fewer inliers than this. */
  minInliers?: number;
  /** Cap on candidate points (deterministic stride subsampling). */
  maxPoints?: number;
};

/** Horizontal-FOV fit from UV <-> camera-space vertices (least squares). */
export type FovFit = {
  horizontalFovDeg: number;
  verticalFovDeg: number;
  fxPx: number;
  fyPx: number;
  /** RMS reprojection residual in pixels (0 for an exact pinhole point map). */
  rmsPx: number;
  samples: number;
  squarePixels: boolean;
  confidence: number;
};

/** The measured camera approximation the studio's score camera is derived from. */
export type CameraMeasurement = {
  heightM: number;
  pitchDeg: number;
  /** Always 0: a monocular keyframe has no absolute yaw; positions carry the framing. */
  yawDeg: number;
  fovDeg: number;
  lensMm: number;
  confidence: number;
  basis: SceneBasis;
};

/** The camera-relative floor frame: up (floor normal), forward (camera axis on the floor) and right. */
export type SceneBasis = {up: Vec3; forward: Vec3; right: Vec3};

export type GroundPoint = {
  xM: number;
  zM: number;
  /** Straight-line floor distance from the camera in metres. */
  distanceM: number;
  /** The point in camera space (metres). */
  cameraPoint: Vec3;
};

export type PersonHeight = {rawM: number; heightM: number; plausible: boolean};

const EPSILON = 1e-9;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < EPSILON) return [0, 0, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}

/** Deterministic PRNG (mulberry32): a seeded RANSAC is reproducible across runs. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pointAt = (points: Float32Array, index: number): Vec3 => [points[index * 3], points[index * 3 + 1], points[index * 3 + 2]];

/** Camera-space samples that can plausibly be part of a floor: in front of the camera, finite, not absurdly far. */
function floorCandidates(points: Float32Array, maxPoints: number): {indices: number[]; stride: number} {
  const total = Math.floor(points.length / 3);
  const indices: number[] = [];
  for (let index = 0; index < total; index++) {
    const x = points[index * 3];
    const y = points[index * 3 + 1];
    const z = points[index * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (z < 0.15 || z > 80 || Math.abs(x) > 80 || Math.abs(y) > 40) continue;
    indices.push(index);
  }
  const stride = Math.max(1, Math.ceil(indices.length / Math.max(1, maxPoints)));
  return {indices: stride > 1 ? indices.filter((_, order) => order % stride === 0) : indices, stride};
}

/** Plane through three points, oriented up and normalised; null for degenerate samples. */
function planeThrough(a: Vec3, b: Vec3, c: Vec3): {normal: Vec3; offsetM: number} | null {
  let normal = normalize(cross(sub(b, a), sub(c, a)));
  if (length(normal) < 0.5) return null;
  // A floor normal points up; in camera space "up" is -Y.
  if (normal[1] > 0) normal = scale(normal, -1);
  if (normal[1] > -0.5) return null; // steeper than 60 deg of camera pitch is not a floor
  const offsetM = -dot(normal, a);
  if (offsetM < 0.35 || offsetM > 9) return null; // camera height plausibility
  return {normal, offsetM};
}

function countInliers(points: Float32Array, indices: number[], normal: Vec3, offsetM: number, maxDistanceM: number): {count: number; squared: number; inliers: number[]} {
  const inliers: number[] = [];
  let squared = 0;
  for (const index of indices) {
    const residual = dot(normal, pointAt(points, index)) + offsetM;
    if (Math.abs(residual) <= maxDistanceM) {
      inliers.push(index);
      squared += residual * residual;
    }
  }
  return {count: inliers.length, squared, inliers};
}

/** Smallest-eigenvalue eigenvector of a symmetric 3x3 matrix (Jacobi rotations). */
function smallestEigenvector(matrix: number[][]): Vec3 {
  const a = matrix.map((row) => [...row]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 12; sweep++) {
    let offDiagonal = 0;
    for (let row = 0; row < 3; row++) for (let column = row + 1; column < 3; column++) offDiagonal += a[row][column] * a[row][column];
    if (offDiagonal < 1e-18) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let index = 1; index < 3; index++) if (a[index][index] < a[best][best]) best = index;
  return normalize([v[0][best], v[1][best], v[2][best]]);
}

/** Least-squares refit of a plane through its inliers (PCA normal). */
function refinePlane(points: Float32Array, inliers: number[]): {normal: Vec3; offsetM: number} | null {
  if (inliers.length < 3) return null;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const index of inliers) {
    cx += points[index * 3];
    cy += points[index * 3 + 1];
    cz += points[index * 3 + 2];
  }
  const count = inliers.length;
  cx /= count;
  cy /= count;
  cz /= count;
  const covariance = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const index of inliers) {
    const dx = points[index * 3] - cx;
    const dy = points[index * 3 + 1] - cy;
    const dz = points[index * 3 + 2] - cz;
    covariance[0][0] += dx * dx;
    covariance[0][1] += dx * dy;
    covariance[0][2] += dx * dz;
    covariance[1][1] += dy * dy;
    covariance[1][2] += dy * dz;
    covariance[2][2] += dz * dz;
  }
  covariance[1][0] = covariance[0][1];
  covariance[2][0] = covariance[0][2];
  covariance[2][1] = covariance[1][2];
  let normal = smallestEigenvector(covariance);
  if (length(normal) < 0.5) return null;
  if (normal[1] > 0) normal = scale(normal, -1);
  return {normal, offsetM: -(normal[0] * cx + normal[1] * cy + normal[2] * cz)};
}

/**
 * Deterministic RANSAC floor plane from camera-space points.
 * Returns null when no plausible, sufficiently supported floor is found.
 */
export function fitFloorPlane(points: Float32Array, options: FloorOptions = {}): FloorPlane | null {
  const maxDistanceM = options.maxDistanceM ?? 0.03;
  const iterations = options.iterations ?? 256;
  const seed = options.seed ?? 0x5eed1234;
  const minInliers = options.minInliers ?? 40;
  const {indices} = floorCandidates(points, options.maxPoints ?? 60_000);
  if (indices.length < Math.max(3, minInliers)) return null;
  const random = mulberry32(seed);
  let best: {normal: Vec3; offsetM: number; inliers: number[]; squared: number} | null = null;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const a = indices[Math.floor(random() * indices.length)];
    const b = indices[Math.floor(random() * indices.length)];
    const c = indices[Math.floor(random() * indices.length)];
    if (a === b || b === c || a === c) continue;
    const plane = planeThrough(pointAt(points, a), pointAt(points, b), pointAt(points, c));
    if (!plane) continue;
    const inlierInfo = countInliers(points, indices, plane.normal, plane.offsetM, maxDistanceM);
    if (!best || inlierInfo.count > best.inliers.length || (inlierInfo.count === best.inliers.length && inlierInfo.squared < best.squared)) {
      best = {...plane, inliers: inlierInfo.inliers, squared: inlierInfo.squared};
    }
  }
  if (!best || best.inliers.length < minInliers) return null;
  const refined = refinePlane(points, best.inliers) ?? {normal: best.normal, offsetM: best.offsetM};
  if (refined.normal[1] > -0.2 || refined.offsetM <= 0.2 || refined.offsetM > 9) return null;
  // Recount against the refined plane so inliers/confidence describe the returned plane.
  const final = countInliers(points, indices, refined.normal, refined.offsetM, maxDistanceM);
  if (final.count < minInliers) return null;
  return {
    normal: refined.normal,
    offsetM: refined.offsetM,
    inliers: final.count,
    confidence: clamp(final.count / indices.length, 0, 1),
    candidateCount: indices.length,
    rmsM: Math.sqrt(final.squared / Math.max(1, final.count)),
  };
}

/** A floor plane is only usable if it really is the floor: near-vertical up-normal, plausible camera height, enough support. */
export const FLOOR_MAX_TILT_DEG = 25;
export const FLOOR_MIN_HEIGHT_M = 0.6;
export const FLOOR_MAX_HEIGHT_M = 2.6;
export const FLOOR_MIN_INLIERS = 40;

export type FloorGateOptions = {
  maxTiltDeg?: number;
  minHeightM?: number;
  maxHeightM?: number;
  minInliers?: number;
};

/**
 * The plausibility gate for a fitted floor (: a shot without a usable floor
 * is not measured). A clothing/close-up plane passes RANSAC with a wildly tilted
 * normal and a short camera height; a wall passes with a horizontal normal. Both
 * must be rejected, or the studio gets a fabricated pitch.
 */
export type FloorVerdict = {
  ok: boolean;
  /** Angle between the floor up-normal and vertical, degrees (0 = a level floor). */
  tiltDeg: number;
  /** Why the floor is unusable; empty when ok. */
  reasons: string[];
};

export function floorPlausibility(
  floor: Pick<FloorPlane, "normal" | "offsetM" | "inliers">,
  options: FloorGateOptions = {},
): FloorVerdict {
  const maxTiltDeg = options.maxTiltDeg ?? FLOOR_MAX_TILT_DEG;
  const minHeightM = options.minHeightM ?? FLOOR_MIN_HEIGHT_M;
  const maxHeightM = options.maxHeightM ?? FLOOR_MAX_HEIGHT_M;
  const minInliers = options.minInliers ?? FLOOR_MIN_INLIERS;
  const normal = normalize(floor.normal);
  // Camera +Y is down, so the floor's up-normal should be close to (0, -1, 0).
  const tiltDeg = normal[1] === 0 && normal[0] === 0 && normal[2] === 0 ? 180 : (Math.acos(clamp(-normal[1], -1, 1)) * 180) / Math.PI;
  const reasons: string[] = [];
  if (!(tiltDeg <= maxTiltDeg)) reasons.push(`tilt ${tiltDeg.toFixed(1)} deg > ${maxTiltDeg} deg`);
  if (!(floor.offsetM >= minHeightM && floor.offsetM <= maxHeightM)) {
    reasons.push(`camera height ${floor.offsetM.toFixed(2)} m outside ${minHeightM}..${maxHeightM} m`);
  }
  if (!(floor.inliers >= minInliers)) reasons.push(`only ${floor.inliers} inliers < ${minInliers}`);
  return {ok: reasons.length === 0, tiltDeg, reasons};
}

/** The camera-relative floor frame used for xM/zM positions. */
export function sceneBasis(floor: Pick<FloorPlane, "normal">): SceneBasis {
  const up = normalize(floor.normal);
  const cameraForward: Vec3 = [0, 0, 1];
  let forward = normalize(sub(cameraForward, scale(up, dot(cameraForward, up))));
  if (length(forward) < 0.5) {
    // Camera pointing straight down/up: any consistent direction works, pick +Z.
    forward = normalize(sub([0, 0, 1], scale(up, dot([0, 0, 1], up)))) as Vec3;
    if (length(forward) < 0.5) forward = [1, 0, 0];
  }
  // Stage +x is the stage camera's LEFT: a camera looking along +z with +y up (three.js) has its
  // screen right at -x. So image right maps to -x; forward x up gave +x and mirrored every
  // reconstruction left to right (2026-11-13, test/stage-orientation.test.ts).
  const right = normalize(cross(up, forward));
  return {up, forward, right};
}

/** Camera height and pitch measured against the floor plane. */
export function cameraFromFloor(floor: Pick<FloorPlane, "normal" | "offsetM" | "confidence">): {heightM: number; pitchDeg: number; yawDeg: number; confidence: number} {
  const normal = normalize(floor.normal);
  return {
    heightM: floor.offsetM,
    // Level camera: normal (0,-1,0) -> 0 deg. Looking down tilts normal.z negative.
    pitchDeg: (Math.atan2(-normal[2], -normal[1]) * 180) / Math.PI,
    yawDeg: 0,
    confidence: clamp(floor.confidence, 0, 1),
  };
}

/**
 * Least-squares horizontal/vertical FOV from the mesh's UV <-> camera-space positions.
 * MoGe unprojects pixel centres with normalised intrinsics, so UVs reproduce the
 * pinhole model exactly and the fit is a robust way to recover the lens.
 */
export function fitFovFromUv(positions: Float32Array, uvs: Float32Array, width: number, height: number, options: {maxSamples?: number} = {}): FovFit | null {
  if (width < 2 || height < 2) return null;
  const vertexCount = Math.min(Math.floor(positions.length / 3), Math.floor(uvs.length / 2));
  if (vertexCount < 8) return null;
  const maxSamples = options.maxSamples ?? 80_000;
  const stride = Math.max(1, Math.ceil(vertexCount / maxSamples));
  let sumXX = 0;
  let sumUX = 0;
  let sumYY = 0;
  let sumVY = 0;
  let samples = 0;
  for (let vertex = 0; vertex < vertexCount; vertex += stride) {
    const z = positions[vertex * 3 + 2];
    if (!(z > 0.1) || !Number.isFinite(z)) continue;
    const xn = positions[vertex * 3] / z;
    const yn = positions[vertex * 3 + 1] / z;
    if (!Number.isFinite(xn) || !Number.isFinite(yn)) continue;
    // Pixel centres: uv is per-pixel index / (size - 1).
    const uCenter = (uvs[vertex * 2] * (width - 1) + 0.5) / width - 0.5;
    const vCenter = (uvs[vertex * 2 + 1] * (height - 1) + 0.5) / height - 0.5;
    sumXX += xn * xn;
    sumUX += uCenter * xn;
    sumYY += yn * yn;
    sumVY += vCenter * yn;
    samples += 1;
  }
  if (samples < 8 || sumXX < EPSILON || sumYY < EPSILON) return null;
  // Least squares through the origin: uCenter = fxNorm * xn  ->  fxNorm = sum(uCenter*xn) / sum(xn^2).
  const fxNorm = sumUX / sumXX;
  const fyNorm = sumVY / sumYY;
  if (!(fxNorm > 0) || !(fyNorm > 0) || !Number.isFinite(fxNorm) || !Number.isFinite(fyNorm)) return null;
  const fxPx = fxNorm * width;
  const fyPx = fyNorm * height;
  const horizontalFovDeg = (2 * Math.atan(width / (2 * fxPx)) * 180) / Math.PI;
  const verticalFovDeg = (2 * Math.atan(height / (2 * fyPx)) * 180) / Math.PI;
  if (!(horizontalFovDeg > 3 && horizontalFovDeg < 175)) return null;
  // Residual check: for an exact point map the fit is exact; a poor fit means the
  // UVs do not correspond to this point cloud (wrong width/height or a corrupt mesh).
  let squaredResidual = 0;
  let checked = 0;
  for (let vertex = 0; vertex < vertexCount; vertex += stride) {
    const z = positions[vertex * 3 + 2];
    if (!(z > 0.1) || !Number.isFinite(z)) continue;
    const expectedU = fxPx * (positions[vertex * 3] / z);
    const expectedV = fyPx * (positions[vertex * 3 + 1] / z);
    const uPx = uvs[vertex * 2] * (width - 1);
    const vPx = uvs[vertex * 2 + 1] * (height - 1);
    squaredResidual += (uPx - (width / 2 - 0.5) - expectedU) ** 2 + (vPx - (height / 2 - 0.5) - expectedV) ** 2;
    checked += 1;
  }
  const rmsPx = Math.sqrt(squaredResidual / Math.max(1, checked));
  const squarePixels = Math.abs(fxPx - fyPx) / Math.max(fxPx, fyPx) < 0.02;
  return {
    horizontalFovDeg,
    verticalFovDeg,
    fxPx,
    fyPx,
    rmsPx,
    samples,
    squarePixels,
    confidence: clamp(1 - rmsPx / 3, 0, 1) * (squarePixels ? 1 : 0.75),
  };
}

/** Combine the floor and lens measurements into the contract's camera approximation. */
export function measureCamera(floor: Pick<FloorPlane, "normal" | "offsetM" | "confidence">, fov: Pick<FovFit, "horizontalFovDeg" | "confidence"> | null): CameraMeasurement {
  const floorCamera = cameraFromFloor(floor);
  const fovDeg = fov ? Math.min(170, Math.max(5, fov.horizontalFovDeg)) : 60;
  const fovConfidence = fov ? clamp(fov.confidence, 0, 1) : 0.2;
  const basis = sceneBasis(floor);
  return {
    heightM: floorCamera.heightM,
    pitchDeg: floorCamera.pitchDeg,
    yawDeg: 0,
    fovDeg,
    lensMm: lensMmFromHorizontalFov(fovDeg),
    confidence: clamp(0.65 * floorCamera.confidence + 0.35 * fovConfidence, 0, 1),
    basis,
  };
}

/** The camera-space point of the floor directly below the camera: the origin of xM/zM. */
export function floorOriginCamera(floor: Pick<FloorPlane, "normal" | "offsetM">): Vec3 {
  const normal = normalize(floor.normal);
  // The camera is at the origin above the floor; -normal points at the floor.
  return scale(normal, -floor.offsetM);
}

/** Convert a floor position to camera space (the inverse of groundPointFromPixel). */
export function cameraPointFromScene(floor: Pick<FloorPlane, "normal" | "offsetM">, basis: SceneBasis, xM: number, zM: number): Vec3 {
  return add(add(floorOriginCamera(floor), scale(basis.right, xM)), scale(basis.forward, zM));
}

/** Project a camera-space point to pixel coordinates; null behind the camera. */
export function projectToPixel(intrinsics: CameraIntrinsics, point: Vec3): {px: number; py: number} | null {
  if (!(point[2] > 1e-4)) return null;
  return {
    px: intrinsics.width / 2 - 0.5 + (intrinsics.fxPx * point[0]) / point[2],
    py: intrinsics.height / 2 - 0.5 + (intrinsics.fyPx * point[1]) / point[2],
  };
}

/** Unit camera-space ray through a pixel. */
export function rayFromPixel(intrinsics: CameraIntrinsics, px: number, py: number): Vec3 {
  const direction: Vec3 = [(px - (intrinsics.width / 2 - 0.5)) / intrinsics.fxPx, (py - (intrinsics.height / 2 - 0.5)) / intrinsics.fyPx, 1];
  return normalize(direction);
}

/**
 * Where a pixel's ray meets the floor plane, in the camera-relative scene frame.
 * This is how a person's foot point becomes a metric root position.
 */
export function groundPointFromPixel(floor: Pick<FloorPlane, "normal" | "offsetM">, intrinsics: CameraIntrinsics, px: number, py: number): GroundPoint | null {
  const normal = normalize(floor.normal);
  const ray = rayFromPixel(intrinsics, px, py);
  const denominator = dot(normal, ray);
  if (Math.abs(denominator) < 1e-6) return null;
  const distance = -floor.offsetM / denominator;
  if (!(distance > 0)) return null;
  const cameraPoint = scale(ray, distance);
  const basis = sceneBasis(floor);
  const xM = dot(cameraPoint, basis.right);
  const zM = dot(cameraPoint, basis.forward);
  return {xM, zM, distanceM: Math.hypot(xM, zM), cameraPoint};
}

/**
 * Place a person's root on the floor from a head pixel and the ~1.7 m height prior.
 *
 * Used when the feet are outside the frame (walking-towards-camera shots): the mask
 * top is the head, so the ray through it reaches a point `priorHeightM` above the
 * floor; dropping that point straight down the floor normal gives the root. This is
 * the anchor explicitly allows; it is not a measurement of the height.
 */
export type HeadPriorGroundPoint = GroundPoint & {
  /** The head height above the floor that produced this root (the prior, or the camera-height fallback). */
  headHeightM: number;
  /** True when the prior was below the measured camera height and the ray pointed above the horizon. */
  usedCameraHeightFallback: boolean;
};

export function groundPointFromHeadPrior(
  floor: Pick<FloorPlane, "normal" | "offsetM">,
  intrinsics: CameraIntrinsics,
  headPixel: {px: number; py: number},
  priorHeightM: number,
): HeadPriorGroundPoint | null {
  if (!(priorHeightM > 0)) return null;
  const normal = normalize(floor.normal);
  const ray = rayFromPixel(intrinsics, headPixel.px, headPixel.py);
  const denominator = dot(normal, ray);
  if (Math.abs(denominator) < 1e-6) return null;
  const rootAtHeadHeight = (headHeightM: number): HeadPriorGroundPoint | null => {
    // Height above the floor of a point t*ray is n.(t*ray) + offsetM.
    const distance = (headHeightM - floor.offsetM) / denominator;
    if (!(distance > 0)) return null;
    const headPoint = scale(ray, distance);
    const root = sub(headPoint, scale(normal, headHeightM));
    const basis = sceneBasis(floor);
    const xM = dot(root, basis.right);
    const zM = dot(root, basis.forward);
    return {xM, zM, distanceM: Math.hypot(xM, zM), cameraPoint: root, headHeightM, usedCameraHeightFallback: false};
  };
  const withPrior = rootAtHeadHeight(priorHeightM);
  if (withPrior) return withPrior;
  // MoGe's metric scale can overestimate the camera height: if the head pixel is above the
  // horizon the head must be above the camera eye level, so a floor prior below the measured
  // camera height has no solution. Fall back to "head just above camera eye level", which
  // keeps a person-rooted shot measurable instead of silently skipping it.
  const fallbackHeadHeightM = floor.offsetM + Math.max(0.1, priorHeightM * 0.1);
  const withFallback = rootAtHeadHeight(fallbackHeadHeightM);
  if (!withFallback) return null;
  return {...withFallback, usedCameraHeightFallback: true};
}

/** The ~1.7 m person scale anchor used when a keyframe cannot measure the height. */
export const PERSON_HEIGHT_PRIOR_M = 1.75;

/**
 * How high the mask top is above the floor for a person standing at (xM, zM):
 * find the height along the floor normal whose projection lands on the mask top.
 */
export function personHeightFromMaskTop(
  floor: Pick<FloorPlane, "normal" | "offsetM">,
  intrinsics: CameraIntrinsics,
  root: {xM: number; zM: number},
  topPixel: {px: number; py: number},
  options: {minM?: number; maxM?: number; stepM?: number} = {},
): number | null {
  const basis = sceneBasis(floor);
  const rootPoint = cameraPointFromScene(floor, basis, root.xM, root.zM);
  const minM = options.minM ?? 0.4;
  const maxM = options.maxM ?? 2.6;
  const stepM = options.stepM ?? 0.005;
  let bestHeight = Number.NaN;
  let bestSquared = Number.POSITIVE_INFINITY;
  for (let height = minM; height <= maxM + EPSILON; height += stepM) {
    const projected = projectToPixel(intrinsics, add(rootPoint, scale(basis.up, height)));
    if (!projected) continue;
    const squared = (projected.px - topPixel.px) ** 2 + (projected.py - topPixel.py) ** 2;
    if (squared < bestSquared) {
      bestSquared = squared;
      bestHeight = height;
    }
  }
  return Number.isFinite(bestHeight) ? bestHeight : null;
}

/** The ~1.7 m person-height sanity anchor: report the raw value, clamp only outside 1.2..2.1 m. */
export function plausiblePersonHeight(rawM: number, bounds: {minM?: number; maxM?: number} = {}): PersonHeight {
  const minM = bounds.minM ?? 1.2;
  const maxM = bounds.maxM ?? 2.1;
  const finite = Number.isFinite(rawM) ? rawM : 0;
  return {rawM: finite, heightM: clamp(finite, minM, maxM), plausible: finite >= minM && finite <= maxM};
}

/** Real-world size of the anchors used by the estimated (no-floor) geometry. */
export const PERSON_HEIGHT_ANCHOR_M = 1.75;
/** A human head is ~1/7.5 of the body height (used when only head + shoulders are visible). */
export const HEAD_HEIGHT_ANCHOR_M = PERSON_HEIGHT_ANCHOR_M / 7.5;
/** Head width in metres (~0.15 m), used when only the head width is anchorable (very close face). */
export const HEAD_WIDTH_ANCHOR_M = 0.15;
/** Eye level as a fraction of body height, for the estimated camera height. */
export const EYE_LEVEL_RATIO = 0.93;

/**
 * Distance to a subject of known real size from its apparent size in pixels:
 * d = fxPx * anchorM / anchorPx (pinhole, small-angle assumption).
 */
export function distanceFromAnchorSize(fxPx: number, anchorM: number, anchorPx: number): number | null {
  if (!(fxPx > 0) || !(anchorM > 0) || !(anchorPx > 0)) return null;
  const distanceM = (fxPx * anchorM) / anchorPx;
  if (!Number.isFinite(distanceM) || distanceM < 0.15 || distanceM > 250) return null;
  return distanceM;
}

/** Eye height of a standing person: the estimated camera height when no floor is measurable. */
export function eyeLevelCameraHeightM(personHeightM = PERSON_HEIGHT_ANCHOR_M): number {
  return EYE_LEVEL_RATIO * personHeightM;
}

export type EstimatedRoot = {xM: number; zM: number; bearingRad: number};

/**
 * The root of a person at a known distance from the camera, from their mask centre pixel:
 * the pixel's x bearing through the pinhole camera gives the lateral offset.
 */
export function rootFromAnchorBearing(input: {fxPx: number; centroidPx: number; imageWidth: number; distanceM: number}): EstimatedRoot | null {
  if (!(input.fxPx > 0) || !(input.imageWidth > 2) || !(input.distanceM > 0)) return null;
  // tan(bearing) = (x - cx) / fx, with the pixel-centre convention used everywhere else.
  const tanBearing = (input.centroidPx - (input.imageWidth / 2 - 0.5)) / input.fxPx;
  const bearingRad = Math.atan(tanBearing);
  // Image right is stage -x (the stage camera looks along +z; see sceneBasis).
  return {xM: -input.distanceM * Math.sin(bearingRad), zM: input.distanceM * Math.cos(bearingRad), bearingRad};
}

/** A synthetic level floor for the estimated geometry: the schema needs a floor, nothing was fitted. */
export function syntheticLevelFloor(cameraHeightM: number): FloorPlane {
  return {normal: [0, -1, 0], offsetM: cameraHeightM, inliers: 0, confidence: 0, candidateCount: 0, rmsM: 0};
}
/** Camera-space point (OpenCV: +X right, +Y down, +Z forward) -> stage coordinates (floor y=0). */
export function stagePointFromCamera(floor: Pick<FloorPlane, "normal" | "offsetM">, basis: SceneBasis, cameraPoint: Vec3): Vec3 {
  const normal = normalize(floor.normal);
  // Relative to the floor origin below the camera; the camera sits offsetM above it.
  const relative = add(cameraPoint, scale(normal, floor.offsetM));
  return [dot(relative, basis.right), dot(relative, basis.up), dot(relative, basis.forward)];
}

export type SceneVoxelOptions = {
  /** Voxel edge in metres (0.5 default; 0.25 for short-range shots). */
  voxelSizeM?: number;
  /** Cells with fewer points than this are dropped (15 default). */
  minPointsPerCell?: number;
  /** Hard cap on returned blocks (200 default, contract allows 260). */
  maxBlocks?: number;
  /** Plausibility bounds in stage metres. */
  yMinM?: number;
  yMaxM?: number;
  zMinM?: number;
  zMaxM?: number;
  xMaxAbsM?: number;
  /** Stage-space person roots: blocks covering a person (0.4 m clearance, 0..2.2 m) are dropped. */
  personRoots?: Array<{xM: number; zM: number}>;
  personClearanceM?: number;
  /** Blocks farther than this z are labelled "background". */
  subjectDistanceM?: number;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Voxelize stage-space points into the coarse "set blocks" the studio draws: 0.5 m cells,
 * x-runs merged, then z-runs merged, implausible cells dropped, person footprints cleared,
 * capped and sorted deterministically. Pure: the same points always give the same blocks.
 */
export function voxelizeStagePoints(points: ArrayLike<number>, options: SceneVoxelOptions = {}): SceneBlock[] {
  const voxel = Math.max(0.1, options.voxelSizeM ?? 0.5);
  const minPoints = Math.max(1, Math.round(options.minPointsPerCell ?? 15));
  const maxBlocks = Math.max(1, Math.round(options.maxBlocks ?? 200));
  const yMin = options.yMinM ?? -0.4;
  const yMax = options.yMaxM ?? 4;
  const zMin = options.zMinM ?? 0.3;
  const zMax = options.zMaxM ?? 30;
  const xMax = options.xMaxAbsM ?? 25;
  type Cell = {ix: number; iy: number; iz: number; count: number};
  const cells = new Map<string, Cell>();
  const count = Math.floor(points.length / 3);
  for (let index = 0; index < count; index++) {
    const x = points[index * 3];
    const y = points[index * 3 + 1];
    const z = points[index * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (y < yMin || y > yMax || z < zMin || z > zMax || Math.abs(x) > xMax) continue;
    const ix = Math.floor(x / voxel);
    const iy = Math.floor(y / voxel);
    const iz = Math.floor(z / voxel);
    const key = `${ix}|${iy}|${iz}`;
    const cell = cells.get(key);
    if (cell) cell.count += 1;
    else cells.set(key, {ix, iy, iz, count: 1});
  }
  if (cells.size === 0) return [];
  // 1. Merge runs along x (same y/z row).
  type Box = {ix0: number; ix1: number; iy: number; iz0: number; iz1: number; count: number};
  const rows = new Map<string, Cell[]>();
  for (const cell of cells.values()) {
    if (cell.count < minPoints) continue;
    const key = `${cell.iy}|${cell.iz}`;
    const row = rows.get(key);
    if (row) row.push(cell);
    else rows.set(key, [cell]);
  }
  const xBoxes: Box[] = [];
  for (const row of rows.values()) {
    row.sort((left, right) => left.ix - right.ix);
    let start = row[0];
    let previous = row[0];
    let total = row[0].count;
    const flush = () => xBoxes.push({ix0: start.ix, ix1: previous.ix, iy: start.iy, iz0: start.iz, iz1: start.iz, count: total});
    for (let index = 1; index < row.length; index++) {
      const cell = row[index];
      if (cell.ix === previous.ix + 1) {
        previous = cell;
        total += cell.count;
        continue;
      }
      flush();
      start = cell;
      previous = cell;
      total = cell.count;
    }
    flush();
  }
  // 2. Merge runs along z (same y and same x span).
  const zGroups = new Map<string, Box[]>();
  for (const box of xBoxes) {
    const key = `${box.iy}|${box.ix0}|${box.ix1}`;
    const group = zGroups.get(key);
    if (group) group.push(box);
    else zGroups.set(key, [box]);
  }
  const merged: Box[] = [];
  for (const group of zGroups.values()) {
    group.sort((left, right) => left.iz0 - right.iz0);
    let current = {...group[0]};
    for (let index = 1; index < group.length; index++) {
      const box = group[index];
      if (box.iz0 <= current.iz1 + 1) {
        current.iz1 = Math.max(current.iz1, box.iz1);
        current.count += box.count;
      } else {
        merged.push(current);
        current = {...box};
      }
    }
    merged.push(current);
  }
  // 2b. Merge runs along y (same x and z span): a wall becomes one column, not a stack of slabs,
  //     so the block budget covers the whole set instead of a few layers of it.
  type Column = {ix0: number; ix1: number; iy0: number; iy1: number; iz0: number; iz1: number; count: number};
  const yGroups = new Map<string, Box[]>();
  for (const box of merged) {
    const key = `${box.ix0}|${box.ix1}|${box.iz0}|${box.iz1}`;
    const group = yGroups.get(key);
    if (group) group.push(box);
    else yGroups.set(key, [box]);
  }
  const columns: Column[] = [];
  for (const group of yGroups.values()) {
    group.sort((left, right) => left.iy - right.iy);
    let current: Column = {ix0: group[0].ix0, ix1: group[0].ix1, iy0: group[0].iy, iy1: group[0].iy, iz0: group[0].iz0, iz1: group[0].iz1, count: group[0].count};
    for (let index = 1; index < group.length; index++) {
      const box = group[index];
      if (box.iy === current.iy1 + 1) {
        current.iy1 = box.iy;
        current.count += box.count;
      } else {
        columns.push(current);
        current = {ix0: box.ix0, ix1: box.ix1, iy0: box.iy, iy1: box.iy, iz0: box.iz0, iz1: box.iz1, count: box.count};
      }
    }
    columns.push(current);
  }
  // 3. Blocks, with person clearance and labels.
  const clearance = Math.max(0, options.personClearanceM ?? 0.4);
  const blocks: Array<SceneBlock & {pointCount: number}> = [];
  for (const box of columns) {
    const sizeX = (box.ix1 - box.ix0 + 1) * voxel;
    const sizeY = (box.iy1 - box.iy0 + 1) * voxel;
    const sizeZ = (box.iz1 - box.iz0 + 1) * voxel;
    const centre: [number, number, number] = [
      (box.ix0 + (box.ix1 - box.ix0 + 1) / 2) * voxel,
      box.iy0 * voxel + sizeY / 2,
      (box.iz0 + (box.iz1 - box.iz0 + 1) / 2) * voxel,
    ];
    const boxY0 = box.iy0 * voxel;
    const boxY1 = boxY0 + sizeY;
    const coversPerson = (options.personRoots ?? []).some((root) => {
      if (!(boxY1 > 0 && boxY0 < 2.2)) return false;
      const reach = clearance + Math.max(sizeX, sizeZ) / 2;
      return Math.hypot(centre[0] - root.xM, centre[2] - root.zM) < reach;
    });
    if (coversPerson) continue;
    let kind: NonNullable<SceneBlock["kind"]> = "object";
    if (centre[1] - sizeY / 2 <= 0.3 && sizeY <= 0.6) kind = "ground";
    else if (sizeY >= 1.2 && sizeY > Math.max(sizeX, sizeZ)) kind = "wall";
    else if (options.subjectDistanceM !== undefined && centre[2] > options.subjectDistanceM + 0.5) kind = "background";
    blocks.push({
      xM: round2(centre[0]),
      yM: round2(centre[1]),
      zM: round2(centre[2]),
      sizeX: round2(sizeX),
      sizeY: round2(sizeY),
      sizeZ: round2(sizeZ),
      kind,
      pointCount: box.count,
    });
  }
  // 4. Cap: keep the blocks closest to the camera carrying the most points.
  blocks.sort((left, right) => right.pointCount / (1 + right.zM) - left.pointCount / (1 + left.zM));
  const kept = blocks.slice(0, maxBlocks);
  kept.sort((left, right) => left.zM - right.zM || left.xM - right.xM || left.yM - right.yM);
  return kept.map(({pointCount: _pointCount, ...block}) => block);
}

/** Depth bands of the rebuilt set: fine cells near the camera, coarser ones far away. */
export const SET_DEPTH_BANDS: ReadonlyArray<{zMinM: number; zMaxM: number; voxelSizeM: number; maxBlocks: number}> = [
  {zMinM: 0.3, zMaxM: 4, voxelSizeM: 0.12, maxBlocks: 260},
  {zMinM: 4, zMaxM: 10, voxelSizeM: 0.25, maxBlocks: 200},
  {zMinM: 10, zMaxM: 30, voxelSizeM: 0.5, maxBlocks: 140},
];
/** Upper bound of a shot's set over all bands (the contract allows this many blocks). */
export const MAX_SET_BLOCKS = SET_DEPTH_BANDS.reduce((total, band) => total + band.maxBlocks, 0);

/**
 * The rebuilt set of one shot: the stage points voxelized per depth band (a cell covers a
 * similar image area in every band, so near furniture keeps its shape and the far background
 * does not eat the block budget), then concatenated in camera-distance order. Pure.
 */
export function voxelizeSetBands(points: ArrayLike<number>, options: Omit<SceneVoxelOptions, "voxelSizeM" | "maxBlocks" | "zMinM" | "zMaxM"> = {}): SceneBlock[] {
  const blocks: SceneBlock[] = [];
  for (const band of SET_DEPTH_BANDS) {
    blocks.push(...voxelizeStagePoints(points, {...options, voxelSizeM: band.voxelSizeM, maxBlocks: band.maxBlocks, zMinM: band.zMinM, zMaxM: band.zMaxM}));
  }
  return blocks;
}

/**
 * A level floor tilted by the camera pitch, for a shot whose floor could not be fitted: the set
 * points are then placed for a camera at `cameraHeightM` looking `pitchDeg` down (positive) or up.
 * The inverse of cameraFromFloor's pitch: normal (0, -cos p, -sin p).
 */
export function pitchedLevelFloor(cameraHeightM: number, pitchDeg: number): FloorPlane {
  const pitch = (pitchDeg * Math.PI) / 180;
  return {normal: [0, -Math.cos(pitch), -Math.sin(pitch)], offsetM: cameraHeightM, inliers: 0, confidence: 0, candidateCount: 0, rmsM: 0};
}

/**
 * The estimated backdrop for a no-floor close-up: a wall strictly BEHIND the subject (never in
 * front of or at the camera) plus a thin near-camera floor strip.
 *
 * Wall: front face at subjectDistanceM + WALL_GAP (0.4..0.8 m, at least +0.2 m), depth
 * 0.3..0.5 m, width from the horizontal FOV at that depth, height 2.6..2.8 m spanning y 0..2.8.
 * Floor strip: 0.02 m thick, z from 0.3 m to the subject distance (it may come near the camera).
 * No block intersects the camera zone (z < 0.3 m or |x| < 0.2 m right at the camera), no wall
 * block sits between camera and subject, and wall blocks overlapping a person root (0.3 m in
 * x/z) are dropped.
 */
export function estimatedBackdropBlocks(input: {
  subjectDistanceM: number;
  horizontalFovDeg: number;
  cameraHeightM: number;
  personRoots?: Array<{xM: number; zM: number}>;
  maxBlocks?: number;
}): SceneBlock[] {
  const distance = Math.max(0.6, input.subjectDistanceM);
  const halfTan = Math.tan((Math.min(170, Math.max(5, input.horizontalFovDeg)) * Math.PI) / 360);
  const wallGap = Math.min(0.8, Math.max(0.4, 0.4 + distance * 0.05));
  const wallDepth = 0.4;
  const wallFrontZ = distance + wallGap;
  const wallCentreZ = wallFrontZ + wallDepth / 2;
  // Width taken at the wall depth (+ margin) so the wall always covers the whole FOV behind the subject.
  const width = Math.max(1.2, 2 * halfTan * (wallFrontZ + 0.5));
  const wallHeight = 2.8;
  const columns = 4;
  const rows = 3;
  const clearance = 0.3;
  const personRoots = input.personRoots ?? [];
  const overlapsPerson = (xMin: number, xMax: number, zMin: number, zMax: number): boolean =>
    personRoots.some((root) => root.xM + clearance > xMin && root.xM - clearance < xMax && root.zM + clearance > zMin && root.zM - clearance < zMax);
  const blocks: SceneBlock[] = [];
  const columnWidth = width / columns;
  const rowHeight = wallHeight / rows;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const xM = -width / 2 + columnWidth / 2 + column * columnWidth;
      if (overlapsPerson(xM - columnWidth / 2, xM + columnWidth / 2, wallCentreZ - wallDepth / 2, wallCentreZ + wallDepth / 2)) continue;
      blocks.push({
        xM: round2(xM),
        yM: round2(rowHeight / 2 + row * rowHeight),
        zM: round2(wallCentreZ),
        sizeX: round2(columnWidth),
        sizeY: round2(rowHeight),
        sizeZ: round2(wallDepth),
        kind: "background",
      });
    }
  }
  // A THIN floor strip from just in front of the camera (z >= 0.3) up to the subject distance.
  const stripSegments = 3;
  const stripStartZ = 0.3;
  const stripEndZ = Math.max(stripStartZ + 0.1, Math.min(distance, wallFrontZ - 0.2));
  const stripLength = (stripEndZ - stripStartZ) / stripSegments;
  for (let index = 0; index < stripSegments; index++) {
    const zMin = round2(stripStartZ + index * stripLength);
    const zMax = round2(zMin + stripLength);
    const zMid = (zMin + zMax) / 2;
    const stripWidth = Math.max(0.4, 2 * halfTan * zMid);
    const xM = 0;
    // Only the wall's blocks and this thin floor strip may be near the camera; keep the floor flat.
    if (overlapsPerson(xM - stripWidth / 2, xM + stripWidth / 2, zMin, zMax)) continue;
    blocks.push({
      xM,
      yM: 0.01,
      zM: round2(zMid),
      sizeX: round2(stripWidth),
      sizeY: 0.02,
      sizeZ: round2(zMax - zMin),
      kind: "ground",
    });
  }
  void input.cameraHeightM;
  const cap = Math.max(1, Math.round(input.maxBlocks ?? 200));
  return blocks.slice(0, cap);
}
/** Convert a measured floor + lens pair into the shared contract's floor value. */
export function toContractFloor(floor: FloorPlane): GeometryFloor {
  return {normal: [...floor.normal] as [number, number, number], offsetM: floor.offsetM, inliers: floor.inliers, confidence: floor.confidence};
}

export const VERTICAL_PERSON_HEIGHT_M = 1.75;

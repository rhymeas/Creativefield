/*
 * Articulated mannequin for the diorama characters (,).
 *
 * Ported from ComfyUI Motion Previs Studio (MIT License, Copyright (c) 2026 AI Director Studio
 * Contributors, https://github.com/navarisun1982/comfyui-motion-previs-studio, commit b32e6dbb):
 * src/engine/kinematics/skeletonHierarchy.ts (19-bone humanoid tree, stylized stand-in),
 * twoBoneIKSolver.ts (closed-form two-bone IK, look-at) and posePresets.ts ("neutral-stand").
 * Changes: metres instead of their stage units, the Mixamo/SMPL paths and sculpt binding are
 * dropped, the figure is sized so the head top equals the measured person height, materials come
 * from the caller, and a hip drop replaces our telescoping capsule for lower postures.
 *
 * Conventions match the stage: y up, the character faces +Z, its left is +X.
 */
import {Bone, CylinderGeometry, Group, Material, Mesh, Quaternion, SphereGeometry, BoxGeometry, Vector3} from "three";

export type HumanoidBone =
  | "Hips" | "Spine" | "Chest" | "Neck" | "Head"
  | "LeftShoulder" | "LeftArm" | "LeftForeArm" | "LeftHand"
  | "RightShoulder" | "RightArm" | "RightForeArm" | "RightHand"
  | "LeftUpLeg" | "LeftLeg" | "LeftFoot"
  | "RightUpLeg" | "RightLeg" | "RightFoot";

type BoneDefinition = {name: HumanoidBone; parent?: HumanoidBone; offset: [number, number, number]};

/** Bone tree in fractions of the rig height (T-pose, arms along X, ankles 0.03 above the floor). */
export const HUMANOID_BONE_TREE: readonly BoneDefinition[] = [
  {name: "Hips", offset: [0, 0.53, 0]},
  {name: "Spine", parent: "Hips", offset: [0, 0.09, 0]},
  {name: "Chest", parent: "Spine", offset: [0, 0.12, 0]},
  {name: "Neck", parent: "Chest", offset: [0, 0.11, 0]},
  {name: "Head", parent: "Neck", offset: [0, 0.08, 0]},
  {name: "LeftShoulder", parent: "Chest", offset: [0.08, 0.05, 0]},
  {name: "LeftArm", parent: "LeftShoulder", offset: [0.08, 0, 0]},
  {name: "LeftForeArm", parent: "LeftArm", offset: [0.15, 0, 0]},
  {name: "LeftHand", parent: "LeftForeArm", offset: [0.14, 0, 0]},
  {name: "RightShoulder", parent: "Chest", offset: [-0.08, 0.05, 0]},
  {name: "RightArm", parent: "RightShoulder", offset: [-0.08, 0, 0]},
  {name: "RightForeArm", parent: "RightArm", offset: [-0.15, 0, 0]},
  {name: "RightHand", parent: "RightForeArm", offset: [-0.14, 0, 0]},
  {name: "LeftUpLeg", parent: "Hips", offset: [0.09, -0.05, 0]},
  {name: "LeftLeg", parent: "LeftUpLeg", offset: [0, -0.225, 0]},
  {name: "LeftFoot", parent: "LeftLeg", offset: [0, -0.225, 0.04]},
  {name: "RightUpLeg", parent: "Hips", offset: [-0.09, -0.05, 0]},
  {name: "RightLeg", parent: "RightUpLeg", offset: [0, -0.225, 0]},
  {name: "RightFoot", parent: "RightLeg", offset: [0, -0.225, 0.04]},
];

/** Head centre (0.97) plus the head radius (0.055 x 1.15): the top of the figure in rig heights. */
export const HEAD_TOP_RATIO = 0.97 + 0.055 * 1.15;
/** The lowest hip drop a posture cue may ask for (a deep crouch), in rig heights. */
export const MAX_HIP_DROP = 0.3;

export type HumanoidRig = {
  root: Group;
  bones: Map<HumanoidBone, Bone>;
  restPositions: Map<HumanoidBone, Vector3>;
  restRotations: Map<HumanoidBone, Quaternion>;
  /** Rig height in metres (the head top is HEAD_TOP_RATIO of it). */
  height: number;
};

export function createHumanoidSkeleton(height: number): HumanoidRig {
  const root = new Group();
  root.name = "mannequin";
  const bones = new Map<HumanoidBone, Bone>();
  const restPositions = new Map<HumanoidBone, Vector3>();
  const restRotations = new Map<HumanoidBone, Quaternion>();
  for (const definition of HUMANOID_BONE_TREE) {
    const bone = new Bone();
    bone.name = definition.name;
    bone.position.set(definition.offset[0] * height, definition.offset[1] * height, definition.offset[2] * height);
    bones.set(definition.name, bone);
    restPositions.set(definition.name, bone.position.clone());
    restRotations.set(definition.name, bone.quaternion.clone());
  }
  for (const definition of HUMANOID_BONE_TREE) {
    const bone = bones.get(definition.name)!;
    (definition.parent ? bones.get(definition.parent)! : root).add(bone);
  }
  root.updateMatrixWorld(true);
  return {root, bones, restPositions, restRotations, height};
}

/** Stylized stand-in: rounded torso, hips, jointed limbs, hands, feet and a +Z eye visor on the head. */
function dressStandin(rig: HumanoidRig, body: Material, joint: Material, visor: Material): void {
  const h = rig.height;
  const attach = (bone: HumanoidBone, mesh: Mesh) => {
    mesh.userData.figure = true;
    rig.bones.get(bone)?.add(mesh);
    return mesh;
  };
  const head = attach("Head", new Mesh(new SphereGeometry(h * 0.055, 24, 20), body));
  head.scale.set(1, 1.15, 1.05);
  head.position.set(0, h * 0.04, 0);
  const eye = attach("Head", new Mesh(new BoxGeometry(h * 0.06, h * 0.02, h * 0.012), visor));
  eye.position.set(0, h * 0.045, h * 0.055);
  // Torso pieces span their whole bone (the original left gaps between hips, belly and chest).
  attach("Chest", new Mesh(new CylinderGeometry(h * 0.075, h * 0.058, h * 0.13, 18), body)).position.set(0, h * 0.06, 0);
  attach("Spine", new Mesh(new CylinderGeometry(h * 0.06, h * 0.058, h * 0.13, 18), body)).position.set(0, h * 0.06, 0);
  attach("Neck", new Mesh(new CylinderGeometry(h * 0.018, h * 0.022, h * 0.06, 10), body)).position.set(0, h * 0.03, 0);
  attach("Hips", new Mesh(new SphereGeometry(h * 0.068, 18, 14), body)).scale.set(1.1, 0.85, 0.85);
  const segment = (bone: HumanoidBone, top: number, bottom: number, length: number, direction: "x" | "-x" | "-y") => {
    attach(bone, new Mesh(new SphereGeometry(top * 1.1, 12, 10), joint));
    const geometry = new CylinderGeometry(top, bottom, length, 12);
    const mesh = attach(bone, new Mesh(geometry, body));
    if (direction === "x") {
      geometry.rotateZ(-Math.PI / 2);
      mesh.position.set(length / 2, 0, 0);
    } else if (direction === "-x") {
      geometry.rotateZ(Math.PI / 2);
      mesh.position.set(-length / 2, 0, 0);
    } else {
      mesh.position.set(0, -length / 2, 0);
    }
  };
  // Clavicles carry the arms out to the shoulder joint (no floating arms).
  segment("LeftShoulder", h * 0.026, h * 0.026, h * 0.08, "x");
  segment("RightShoulder", h * 0.026, h * 0.026, h * 0.08, "-x");
  segment("LeftArm", h * 0.026, h * 0.021, h * 0.15, "x");
  segment("LeftForeArm", h * 0.021, h * 0.016, h * 0.14, "x");
  segment("RightArm", h * 0.026, h * 0.021, h * 0.15, "-x");
  segment("RightForeArm", h * 0.021, h * 0.016, h * 0.14, "-x");
  attach("LeftHand", new Mesh(new BoxGeometry(h * 0.04, h * 0.02, h * 0.035), body)).position.set(h * 0.02, 0, 0);
  attach("RightHand", new Mesh(new BoxGeometry(h * 0.04, h * 0.02, h * 0.035), body)).position.set(-h * 0.02, 0, 0);
  segment("LeftUpLeg", h * 0.042, h * 0.031, h * 0.225, "-y");
  segment("LeftLeg", h * 0.031, h * 0.022, h * 0.225, "-y");
  segment("RightUpLeg", h * 0.042, h * 0.031, h * 0.225, "-y");
  segment("RightLeg", h * 0.031, h * 0.022, h * 0.225, "-y");
  attach("LeftFoot", new Mesh(new BoxGeometry(h * 0.04, h * 0.02, h * 0.08), body)).position.set(0, -h * 0.02, h * 0.03);
  attach("RightFoot", new Mesh(new BoxGeometry(h * 0.04, h * 0.02, h * 0.08), body)).position.set(0, -h * 0.02, h * 0.03);
}

/* ---------------------------------------------------------------- two-bone IK (closed form) */

/** Point `bone` so its child joint lies on the line toward `target` (world space), keeping its roll. */
function orientBoneToward(bone: Bone, child: Bone, target: Vector3): void {
  bone.updateMatrixWorld(true);
  const origin = bone.getWorldPosition(new Vector3());
  const restAxis = child.position.clone().normalize();
  const worldDirection = target.clone().sub(origin).normalize();
  const parent = bone.parent;
  if (restAxis.lengthSq() < 1e-4 || worldDirection.lengthSq() < 1e-4 || !parent) return;
  parent.updateMatrixWorld(true);
  const parentInverse = parent.getWorldQuaternion(new Quaternion()).invert();
  const localDirection = worldDirection.applyQuaternion(parentInverse).normalize();
  const currentDirection = restAxis.applyQuaternion(bone.quaternion).normalize();
  bone.quaternion.premultiply(new Quaternion().setFromUnitVectors(currentDirection, localDirection));
  bone.updateMatrixWorld(true);
}

/** Law-of-cosines IK: root and mid bone rotate so `end` reaches `target`, bending toward `pole`. */
export function solveTwoBoneIK(root: Bone, mid: Bone, end: Bone, target: Vector3, pole: Vector3): void {
  root.updateMatrixWorld(true);
  const rootPosition = root.getWorldPosition(new Vector3());
  const midPosition = mid.getWorldPosition(new Vector3());
  const endPosition = end.getWorldPosition(new Vector3());
  const upper = Math.max(0.001, rootPosition.distanceTo(midPosition));
  const lower = Math.max(0.001, midPosition.distanceTo(endPosition));
  const toTarget = target.clone().sub(rootPosition);
  const distance = Math.min(upper + lower - 0.0005, Math.max(Math.abs(upper - lower) + 0.0005, toTarget.length()));
  toTarget.setLength(distance);
  const alpha = Math.acos(Math.max(-1, Math.min(1, (upper * upper + distance * distance - lower * lower) / (2 * upper * distance))));
  const axis = toTarget.clone().normalize();
  const toPole = pole.clone().sub(rootPosition);
  let bend = toPole.sub(axis.clone().multiplyScalar(toPole.dot(axis))).normalize();
  if (bend.lengthSq() < 1e-4) {
    bend = new Vector3(0, 0, 1).cross(axis).normalize();
    if (bend.lengthSq() < 1e-4) bend = new Vector3(0, 1, 0).cross(axis).normalize();
  }
  const midDirection = axis.clone().multiplyScalar(Math.cos(alpha)).add(bend.multiplyScalar(Math.sin(alpha))).normalize();
  orientBoneToward(root, mid, rootPosition.clone().add(midDirection.multiplyScalar(upper)));
  orientBoneToward(mid, end, rootPosition.clone().add(toTarget));
}

const LIMBS = {
  leftArm: ["LeftArm", "LeftForeArm", "LeftHand"],
  rightArm: ["RightArm", "RightForeArm", "RightHand"],
  leftLeg: ["LeftUpLeg", "LeftLeg", "LeftFoot"],
  rightLeg: ["RightUpLeg", "RightLeg", "RightFoot"],
} as const satisfies Record<string, readonly [HumanoidBone, HumanoidBone, HumanoidBone]>;

/* ---------------------------------------------------------------- pose */

/** A point in the rig's own frame, in rig heights (x left, y up from the floor, z forward), in world space. */
function rigPoint(rig: HumanoidRig, x: number, y: number, z: number): Vector3 {
  return rig.root.localToWorld(new Vector3(x * rig.height, y * rig.height, z * rig.height));
}

function resetToRest(rig: HumanoidRig): void {
  for (const [name, bone] of rig.bones) {
    bone.position.copy(rig.restPositions.get(name)!);
    bone.quaternion.copy(rig.restRotations.get(name)!);
  }
}

function solveLimb(rig: HumanoidRig, limb: keyof typeof LIMBS, target: Vector3, pole: Vector3): void {
  const [root, mid, end] = LIMBS[limb].map((name) => rig.bones.get(name)!);
  for (const bone of [root, mid]) bone.quaternion.copy(rig.restRotations.get(bone.name as HumanoidBone)!);
  rig.root.updateWorldMatrix(true, true);
  solveTwoBoneIK(root, mid, end, target, pole);
}

/** Feet flat on the floor again after the leg IK turned the shins (rest feet point +Z, level). */
function flattenFeet(rig: HumanoidRig): void {
  const rootQuaternion = rig.root.getWorldQuaternion(new Quaternion());
  for (const name of ["LeftFoot", "RightFoot"] as const) {
    const foot = rig.bones.get(name)!;
    foot.parent!.updateMatrixWorld(true);
    const parentInverse = foot.parent!.getWorldQuaternion(new Quaternion()).invert();
    foot.quaternion.copy(parentInverse.multiply(rootQuaternion));
  }
}

/**
 * The "neutral-stand" preset with an optional hip drop (rig heights, 0 = standing): arms hang
 * relaxed with a soft elbow bend, ankles stay on the floor and the knees bend forward to absorb
 * the drop, so a lower posture cue reads as a crouch instead of a shrunken body.
 */
/** A walk cycle state: `phase` in radians (one stride per 2*PI), `amount` 0 (standing) .. 1 (full walk). */
export type WalkState = {phase: number; amount: number};

/** Metres covered per full walk cycle (two steps) for a 1.75 m person; scaled by the rig height. */
export const STRIDE_PER_CYCLE_M = 1.4;

/**
 * Pose with an optional hip drop (rig heights, 0 = standing) and an optional walk. Standing is the
 * "neutral-stand" preset (arms hang relaxed, knees bend forward to absorb a drop, so a lower posture
 * reads as a crouch). Walking follows the gait of Motion Previs Studio's gaitEngine.ts in a reduced
 * form: opposite legs stride forward and back, the swing foot lifts, the arms swing against the legs
 * and the hips bob twice per cycle - so a figure that travels is seen walking, not gliding.
 */
export function poseNeutral(rig: HumanoidRig, hipDrop = 0, walk: WalkState = {phase: 0, amount: 0}): void {
  const drop = Math.max(0, Math.min(MAX_HIP_DROP, hipDrop));
  const amount = Math.max(0, Math.min(1, walk.amount));
  const swing = Math.sin(walk.phase);
  resetToRest(rig);
  const hips = rig.bones.get("Hips")!;
  // Two hip dips per cycle (at each heel strike), about 2 % of the height at full walk.
  const bob = amount * 0.012 * (1 - Math.cos(2 * walk.phase)) / 2;
  hips.position.y -= (drop + bob) * rig.height;
  // A crouch leans the torso forward; a walk adds a slight forward lean and counter-rotation.
  rig.bones.get("Spine")!.rotation.x = drop * 0.9 + amount * 0.06;
  rig.bones.get("Spine")!.rotation.y = -swing * amount * 0.12;
  // Fresh world matrices for the whole chain: the rig sits inside the moving entity group, and
  // the IK mixes world positions with ancestor quaternions, which must come from one state.
  rig.root.updateWorldMatrix(true, true);
  const stride = 0.13 * amount; // half step length in rig heights
  const lift = 0.05 * amount;
  const leg = (offset: number) => {
    const s = Math.sin(walk.phase + offset);
    const c = Math.cos(walk.phase + offset);
    // Forward while swinging (c > 0 lifts the foot), back while the foot is planted.
    return {z: -0.01 + stride * s, y: 0.03 + lift * Math.max(0, c)};
  };
  const left = leg(0);
  const right = leg(Math.PI);
  // Arms swing against the leg on the same side.
  const armSwing = 0.16 * amount;
  solveLimb(rig, "leftArm", rigPoint(rig, 0.145, 0.515 - drop - bob, 0.02 + drop * 0.5 - armSwing * swing), rigPoint(rig, 0.28, 0.63 - drop, -0.22));
  solveLimb(rig, "rightArm", rigPoint(rig, -0.145, 0.515 - drop - bob, 0.02 + drop * 0.5 + armSwing * swing), rigPoint(rig, -0.28, 0.63 - drop, -0.22));
  solveLimb(rig, "leftLeg", rigPoint(rig, 0.055, left.y, left.z), rigPoint(rig, 0.085, 0.3, 0.54 + left.z));
  solveLimb(rig, "rightLeg", rigPoint(rig, -0.055, right.y, right.z), rigPoint(rig, -0.085, 0.3, 0.54 + right.z));
  flattenFeet(rig);
  rig.root.updateMatrixWorld(true);
}

export type Mannequin = {
  rig: HumanoidRig;
  /** Re-pose for a posture cue; a no-op when the drop did not change. */
  setHipDrop: (hipDrop: number) => void;
  /** Re-pose for a posture cue and a walk; a no-op when neither changed visibly. */
  setPose: (hipDrop: number, walk: WalkState) => void;
};

/**
 * A posed mannequin whose head top is `heightM` above the floor. `body` dresses the limbs and
 * torso, `joint` the joint balls, `visor` the eye bar that shows where the figure looks.
 */
export function buildMannequin(heightM: number, materials: {body: Material; joint: Material; visor: Material}): Mannequin {
  const rig = createHumanoidSkeleton(Math.max(0.3, heightM) / HEAD_TOP_RATIO);
  dressStandin(rig, materials.body, materials.joint, materials.visor);
  let current = "";
  const setPose = (hipDrop: number, walk: WalkState) => {
    const drop = Math.round(Math.max(0, Math.min(MAX_HIP_DROP, hipDrop)) * 200) / 200;
    const amount = Math.round(Math.max(0, Math.min(1, walk.amount)) * 50) / 50;
    const phase = amount === 0 ? 0 : Math.round((((walk.phase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) * 100) / 100;
    const key = `${drop}|${amount}|${phase}`;
    if (key === current) return;
    current = key;
    poseNeutral(rig, drop, {phase, amount});
  };
  const setHipDrop = (hipDrop: number) => setPose(hipDrop, {phase: 0, amount: 0});
  setHipDrop(0);
  return {rig, setHipDrop, setPose};
}

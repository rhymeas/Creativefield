/**
 * Block a shot: the three.js meshes for each prop. Geometry only, no renderer and no DOM.
 * Ported from OpenField's Stage (wexloops/openfield, src/stageMesh.ts, MIT License, Copyright (c) 2026
 * David Wexler / Strangeloop Studios); GLB props are not carried over.
 */
import * as THREE from "three";
import { propAt, type StageProp, type StageScene } from "./stage";

const SEG = 28, FIG_W = 0.3, FIG_D = 0.14;

let shared: Record<string, THREE.BufferGeometry> | null = null;
function geo() {
  if (shared) return shared;
  const limb = (r: number, from: number, to: number) => new THREE.CapsuleGeometry(r, to - from - 2 * r, 6, 14).translate(0, (from + to) / 2, 0);
  shared = {
    box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, SEG, 1).translate(0, 0.5, 0),
    sphere: new THREE.SphereGeometry(0.5, SEG, 18).translate(0, 0.5, 0),
    leg: limb(0.04, 0, 0.49), torso: limb(0.08, 0.45, 0.83),
    head: new THREE.SphereGeometry(0.065, 18, 12).translate(0, 0.935, 0), arm: limb(0.03, 0.47, 0.8),
  };
  return shared;
}

/** The object for one prop, with its transform at shot time t. */
export function propObject(p: StageProp, material: THREE.Material, t = 0): THREE.Group {
  const g = geo(), group = new THREE.Group(), [w, h, d] = p.size;
  const add = (geom: THREE.BufferGeometry, sx: number, sy: number, sz: number) => { const m = new THREE.Mesh(geom, material); m.scale.set(sx, sy, sz); group.add(m); };
  if (p.type === "figure") {
    // A mannequin: two legs, torso, head, arms, scaled to the prop's width, height and depth.
    const inner = new THREE.Group();
    for (const [geom, x] of [[g.leg, -0.045], [g.leg, 0.045], [g.torso, 0], [g.head, 0], [g.arm, -0.12], [g.arm, 0.12]] as const) {
      const m = new THREE.Mesh(geom, material); m.position.x = x; inner.add(m);
    }
    inner.scale.set(w / FIG_W, h, d / FIG_D);
    group.add(inner);
  } else if (p.type === "cylinder") add(g.cyl, w, h, d);
  else if (p.type === "sphere") add(g.sphere, w, h, d);
  else add(g.box, w, h, d); // box and wall
  const at = propAt(p, t);
  group.position.set(at[0], at[1], at[2]);
  group.rotation.set(0, (p.rot * Math.PI) / 180, 0);
  return group;
}

/** The ground: a big plane at y = 0, drawn with the checker. */
const groundMesh = (material: THREE.Material): THREE.Mesh => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), material);
  m.userData.ground = true;
  return m;
};

/** Every mesh of a scene at time t, with world matrices up to date (the rasterizer's input). */
export function sceneMeshes(s: StageScene, material: THREE.Material, t: number): { meshes: THREE.Mesh[] } {
  const root = new THREE.Group();
  root.add(groundMesh(material));
  for (const p of s.props) root.add(propObject(p, material, t));
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  return { meshes };
}

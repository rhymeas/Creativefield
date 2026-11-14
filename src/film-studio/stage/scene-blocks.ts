/*
 * Scene blocks from the reference analysis, ready for the three.js diorama.
 *
 * The server voxelises MoGe's point cloud into a few grey boxes per shot (walls,
 * background, furniture, ground). This module only validates and normalises them
 * for the viewport: pure, no three.js import, so the mapping is unit-testable.
 *
 * Blocks are always background: neutral grey, no labels, no accent colour.
 */
import type {SceneBlock} from "../analysis-contract";
import {MAX_SET_BLOCKS} from "../geometry";

export type SceneBlockMesh = {
  /** Centre of the box in stage metres. */
  position: [number, number, number];
  /** Box size in metres, each side at least MIN_SIZE_M. */
  size: [number, number, number];
  /** Neutral grey shade for the block's kind (three.js hex). */
  shade: number;
};

/** A block thinner than this is a sliver, not geometry; keep it barely visible. */
export const MIN_SIZE_M = 0.02;
/** The server caps a shot at MAX_SET_BLOCKS (depth bands); headroom only, so a broken payload cannot stall the frame. */
export const MAX_SCENE_BLOCKS = MAX_SET_BLOCKS + 40;

/** Background shades: neutral grey, darker than the coloured person capsules. */
const SHADES: Record<NonNullable<SceneBlock["kind"]>, number> = {
  wall: 0x4a4f55,
  background: 0x3c4147,
  object: 0x53585e,
  ground: 0x33373b,
};

export function sceneBlockShade(kind: SceneBlock["kind"]): number {
  return SHADES[kind ?? "object"] ?? SHADES.object;
}

/**
 * Map the active shot's blocks to boxes. Values that are not finite numbers are refused
 * (never passed to three.js as NaN), sizes are made positive, and a block is lifted so it
 * never cuts through the floor. The order is kept for stable mesh creation.
 */
export function sceneBlockMeshes(blocks: readonly SceneBlock[] | undefined): SceneBlockMesh[] {
  const meshes: SceneBlockMesh[] = [];
  for (const block of blocks ?? []) {
    if (!block) continue;
    const values = [block.xM, block.yM, block.zM, block.sizeX, block.sizeY, block.sizeZ];
    if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) continue;
    const size: [number, number, number] = [
      Math.max(MIN_SIZE_M, Math.abs(block.sizeX)),
      Math.max(MIN_SIZE_M, Math.abs(block.sizeY)),
      Math.max(MIN_SIZE_M, Math.abs(block.sizeZ)),
    ];
    const position: [number, number, number] = [block.xM, Math.max(size[1] / 2, block.yM), block.zM];
    meshes.push({position, size, shade: sceneBlockShade(block.kind)});
    if (meshes.length >= MAX_SCENE_BLOCKS) break;
  }
  return meshes;
}

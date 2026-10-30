export type CameraMove = "pan-left" | "pan-right" | "pan-up" | "pan-down" | "zoom-in" | "zoom-out";
export type CameraMeasure = { dx: number; dy: number; zoom: number; fit: number; still: number };
export const MOVE_MIN: number;
export const EXPECTED: Record<CameraMove, { dx?: number; dy?: number; zoom?: number }>;
export function analyseCamera(frames: Uint8Array[], width: number, height: number): CameraMeasure;
export function cameraVerdict(measured: CameraMeasure, move: CameraMove): { followed: boolean; reason: string };
export function measureCamera(file: string, options?: { width?: number; run?: typeof import("node:child_process").execFileSync }): CameraMeasure;

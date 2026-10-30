export type Motion = { top: number; middle: number; bottom: number; frames: number };
export const MOVING: number;
export const STATIC_BELOW: number;
export function analyseFrames(frames: Uint8Array[], width: number, height: number): Motion;
export function motionVerdict(motion: Motion): { level: "static" | "partial" | "alive"; reason: string };
export function measureMotion(file: string, options?: { width?: number; run?: typeof import("node:child_process").execFileSync }): Motion;

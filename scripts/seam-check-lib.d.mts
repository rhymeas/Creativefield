export type SeamMeasure = { frames: number; fps: number; verdict: "seamless" | "visible"; ratio: number; texture: { wrap: number; local: number; ratio: number }; composition: { wrap: number; local: number; ratio: number } };
export type Loaded = { tiles: Float32Array[]; tex: Uint8Array[]; fps: number; info: { w: number; h: number; fps: number; frames: number } };
export const SEAM_T: { wrapInvisible: number; seamless: number; localFloor: number; textureSeamless: number; textureInvisible: number; textureFloor: number; minFrames: number };
export function load(file: string): Loaded;
export function scoreWindow(loaded: Loaded, start?: number, end?: number): SeamMeasure;
export function spliceRatio(loaded: Loaded, frame: number): number;
export function planTrim(loaded: Loaded): { start: number; frames: number; predicted: SeamMeasure } | null;

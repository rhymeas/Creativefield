import {execFile} from "node:child_process";
import {promisify} from "node:util";

const execute = promisify(execFile);
// Low threshold keeps subtle camera cuts as candidates; motion and flashes can also trigger it.
const DEFAULT_THRESHOLD = 0.15;

/** All intervals are measured in 24 fps source frames, with an exclusive end. */
export type OpenJutsuShotWindow = {
  shot: number;
  startFrame: number;
  endFrame: number;
  startsAtCut: boolean;
};

/** Parse showinfo timestamps, not its n field: n counts selected frames, not source frames. */
export function parseSceneCutCandidateFrames(stderr: string, fps: number, frameCount: number): number[] {
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isSafeInteger(frameCount) || frameCount < 1)
    throw new Error("Invalid video frame timing");
  const cuts = new Set<number>();
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.includes("showinfo") || !/\bn:\s*\d+/.test(line)) continue;
    const timestamp = /\bpts_time:\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i.exec(line);
    if (!timestamp) continue;
    const seconds = Number(timestamp[1]);
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    const frame = Math.round(seconds * fps);
    if (frame > 0 && frame < frameCount) cuts.add(frame);
  }
  return [...cuts].sort((a, b) => a - b);
}

/** Preserve every frame; callers must provide confirmed cut boundaries, not raw candidates. */
export function planOpenJutsuShots(frameCount: number, cutFrames: readonly number[], maxWindowFrames = 120): OpenJutsuShotWindow[] {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || !Number.isSafeInteger(maxWindowFrames) || maxWindowFrames < 1)
    throw new Error("Invalid shot window length");
  if (cutFrames.some(frame => !Number.isSafeInteger(frame) || frame <= 0 || frame >= frameCount))
    throw new Error("Cut must be an interior source frame");
  const boundaries = [0, ...new Set(cutFrames), frameCount].sort((a, b) => a - b);
  const windows: OpenJutsuShotWindow[] = [];
  for (let shot = 0; shot < boundaries.length - 1; shot++) {
    const start = boundaries[shot], end = boundaries[shot + 1];
    for (let position = start; position < end; position += maxWindowFrames) {
      windows.push({shot, startFrame: position, endFrame: Math.min(position + maxWindowFrames, end), startsAtCut: shot > 0 && position === start});
    }
  }
  return windows;
}

/** Candidate cuts only: fast flashes can look like cuts, and subtle edits can be missed. */
export async function detectOpenJutsuCutCandidates(filename: string, frameCount: number, options: {fps?: number; threshold?: number} = {}): Promise<number[]> {
  const fps = options.fps ?? 24, threshold = options.threshold ?? DEFAULT_THRESHOLD;
  if (!Number.isSafeInteger(fps) || fps < 1 || fps > 120 || !Number.isFinite(threshold) || threshold <= 0 || threshold >= 1)
    throw new Error("Invalid scene detection settings");
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) throw new Error("Invalid video frame count");
  const filter = `setpts=PTS-STARTPTS,fps=${fps},scale=320:-2,select='gt(scene,${threshold})',showinfo`;
  let result: Awaited<ReturnType<typeof execute>>;
  try {
    result = await execute(process.env.FFMPEG_PATH ?? "ffmpeg", ["-nostdin", "-hide_banner", "-i", filename, "-an", "-vf", filter, "-f", "null", "-"], {timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true});
  } catch (error) {
    throw new Error("Could not analyze video cuts", {cause: error});
  }
  return parseSceneCutCandidateFrames(String(result.stderr), fps, frameCount);
}

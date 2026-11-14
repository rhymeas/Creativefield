/**
 * Exact frame timing for a deterministic shot clip. Kept free of three.js and
 * the DOM so the contract (fps, frame count, cap) is unit-testable and the same
 * numbers drive the renderer and the tests.
 */
export type ClipTiming = {times: number[]; fps: number; durationSec: number; truncated: boolean};

export function clipFrameTimes(startSec: number, endSec: number, fps: number, maxFrames = 180): ClipTiming {
  const rate = Math.max(1, Math.min(60, Math.round(fps)));
  const start = Math.max(0, startSec);
  const duration = Math.max(1 / rate, endSec - start);
  const wanted = Math.max(2, Math.round(duration * rate));
  const count = Math.min(Math.max(2, maxFrames), wanted);
  const times = Array.from({length: count}, (_, index) => Math.round((start + index / rate) * 1000) / 1000);
  return {times, fps: rate, durationSec: Math.max(1 / rate, count / rate), truncated: count < wanted};
}

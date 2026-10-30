/* Is a generated clip alive, or a still picture that fades or drifts? Decided from the pixels, not by eye.
   Frames come in as gray bytes, so analyseFrames needs no ffmpeg and test/motion-check-lib.test.ts can
   hand it fake clips. measureMotion is the thin ffmpeg reader around it.

   What is measured: how much each pixel goes back and forth over the clip (total variation minus net
   change, per frame, 0-255), after a 3-frame smoothing that drops codec noise. A fade or a colour change
   moves a pixel one way, so it scores near 0; waves, drifting clouds and a flickering lamp go up and down,
   so they score high. The score is taken for the top, middle and bottom third of the picture because a
   clip where only the sea moves is not alive: every part of the picture should have life. The numbers
   are calibrated on nine real clips (2026-10-29) and are provisional. */

import { execFileSync } from "node:child_process";

/** A region at or above this counts as moving. */
export const MOVING = 0.5;
/** No region reaches this: the clip is static. */
export const STATIC_BELOW = 0.6;

/** @typedef {{top:number,middle:number,bottom:number,frames:number}} Motion */

/**
 * @param {Uint8Array[]} frames gray frames of equal size, at least 5
 * @param {number} width
 * @param {number} height
 * @returns {Motion}
 */
export function analyseFrames(frames, width, height) {
  if (frames.length < 5) throw new Error("A motion check needs at least five frames");
  const size = width * height;
  for (const frame of frames) if (frame.length !== size) throw new Error("Every frame must be width x height gray bytes");
  const steps = frames.length - 2 - 1; // smoothed frames, minus one for the differences between them
  const edges = [0, Math.floor(height / 3), Math.floor((2 * height) / 3), height];
  const excess = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    let variation = 0, net = 0, previous = (frames[0][i] + frames[1][i] + frames[2][i]) / 3;
    for (let f = 1; f < frames.length - 2; f++) {
      const current = (frames[f][i] + frames[f + 1][i] + frames[f + 2][i]) / 3;
      variation += Math.abs(current - previous);
      net += current - previous;
      previous = current;
    }
    excess[i] = (variation - Math.abs(net)) / steps;
  }
  const region = (index) => {
    let sum = 0;
    for (let i = edges[index] * width; i < edges[index + 1] * width; i++) sum += excess[i];
    return round(sum / ((edges[index + 1] - edges[index]) * width));
  };
  return { top: region(0), middle: region(1), bottom: region(2), frames: frames.length };
}

const round = (value) => Math.round(value * 100) / 100;

/**
 * static: nothing moves. partial: some of the picture moves and some does not. alive: all of it does.
 * @param {Motion} motion
 * @returns {{level:"static"|"partial"|"alive",reason:string}}
 */
export function motionVerdict(motion) {
  const parts = /** @type {const} */ (["top", "middle", "bottom"]);
  const best = Math.max(...parts.map((name) => motion[name]));
  if (best < STATIC_BELOW) return { level: "static", reason: `static: the most moving third scores ${best} (needs ${STATIC_BELOW})` };
  const still = parts.filter((name) => motion[name] < MOVING);
  if (still.length) return { level: "partial", reason: `partial: the ${still.join(" and ")} of the picture ${still.length > 1 ? "do" : "does"} not move (below ${MOVING})` };
  return { level: "alive", reason: "alive: every third of the picture moves" };
}

/** Reads a clip with ffmpeg as small gray frames (area-averaged, which also drops noise) and measures it. */
export function measureMotion(file, { width = 40, run = execFileSync } = {}) {
  const probe = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file], { encoding: "utf8" })).streams[0];
  const height = Math.max(3, 2 * Math.round((width * probe.height) / probe.width / 2));
  const raw = run("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${width}:${height}:flags=area,format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 });
  const size = width * height, count = Math.floor(raw.length / size);
  const frames = Array.from({ length: count }, (_, index) => new Uint8Array(raw.buffer, raw.byteOffset + index * size, size));
  return analyseFrames(frames, width, height);
}

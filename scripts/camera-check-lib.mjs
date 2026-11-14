/* Did the camera do what was asked? Decided from the pixels: how far the picture as a whole moved or
   scaled between the first and the last frame. A camera that pans left makes the content slide right;
   one that zooms in makes the content grow. Frames come in as gray bytes, so analyseCamera needs no
   ffmpeg and test/camera-check-lib.test.ts can hand it fake clips. measureCamera is the ffmpeg reader.
   Thresholds are calibrated on real clips and are provisional. */

import { execFileSync } from "node:child_process";

/** A move counts when the picture shifts or scales by at least this share of its size. */
export const MOVE_MIN = 0.02;

/** Which way the content travels for a camera move: dx/dy as +1/-1 (right/down), zoom as the scale direction. */
export const EXPECTED = {
  "pan-left": { dx: 1 }, "pan-right": { dx: -1 },
  "pan-up": { dy: 1 }, "pan-down": { dy: -1 },
  "zoom-in": { zoom: 1 }, "zoom-out": { zoom: -1 },
};

const sad = (a, b, w, h, dx, dy, margin) => {
  let sum = 0, n = 0;
  for (let y = margin; y < h - margin; y++) for (let x = margin; x < w - margin; x++) {
    const sx = x + dx, sy = y + dy;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    sum += Math.abs(a[y * w + x] - b[sy * w + sx]); n++;
  }
  return sum / n;
};
const sadScale = (a, b, w, h, s, margin) => {
  let sum = 0, n = 0;
  const cx = w / 2, cy = h / 2;
  for (let y = margin; y < h - margin; y++) for (let x = margin; x < w - margin; x++) {
    const fx = (x - cx) / s + cx, fy = (y - cy) / s + cy, x0 = Math.floor(fx), y0 = Math.floor(fy);
    if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
    const tx = fx - x0, ty = fy - y0, i = y0 * w + x0;
    const v = a[i] * (1 - tx) * (1 - ty) + a[i + 1] * tx * (1 - ty) + a[i + w] * (1 - tx) * ty + a[i + w + 1] * tx * ty;
    sum += Math.abs(v - b[y * w + x]); n++;
  }
  return sum / n;
};

const refine = (lo, mid, hi) => { const d = lo - 2 * mid + hi; return d > 0 ? (lo - hi) / (2 * d) : 0; };

/** Movement of the content from frame a to frame b: small steps only, so the picture still matches itself. */
function step(a, b, w, h) {
  const reach = 3, margin = reach + 1, errors = new Map();
  const at = (dx, dy) => { const k = `${dx},${dy}`; if (!errors.has(k)) errors.set(k, sad(b, a, w, h, -dx, -dy, margin)); return errors.get(k); };
  let best = { e: Infinity, dx: 0, dy: 0 };
  for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) { const e = at(dx, dy); if (e < best.e) best = { e, dx, dy }; }
  const inside = (v) => Math.abs(v) < reach;
  const fx = inside(best.dx) ? refine(at(best.dx - 1, best.dy), best.e, at(best.dx + 1, best.dy)) : 0;
  const fy = inside(best.dy) ? refine(at(best.dx, best.dy - 1), best.e, at(best.dx, best.dy + 1)) : 0;
  return { dx: best.dx + fx, dy: best.dy + fy, panFit: best.e };
}

/** Size change from frame a to frame b; the frames are far enough apart for a slow zoom to show. */
function grow(a, b, w, h) {
  let zoom = { e: Infinity, s: 1 };
  for (let s = 0.9; s <= 1.10001; s += 0.004) { const e = sadScale(a, b, w, h, s, 5); if (e < zoom.e) zoom = { e, s }; }
  /* A size change must beat "no change" clearly, or noise and the picture's own motion pick a scale at random. */
  const still = sadScale(a, b, w, h, 1, 5);
  return zoom.e < still * 0.9 ? { zoom: Math.log(zoom.s), zoomFit: zoom.e, still } : { zoom: 0, zoomFit: still, still };
}

/**
 * @param {Uint8Array[]} frames gray frames of equal size, at least 2
 * @returns {{dx:number,dy:number,zoom:number}} content movement first -> last: dx/dy as a share of width/height
 *   (+ right/down), zoom as the relative size change (+ larger). The steps between neighbouring frames are
 *   added up, which keeps working when a long clip has changed too much for first and last to be compared.
 */
export function analyseCamera(frames, width, height) {
  if (frames.length < 2) throw new Error("A camera check needs at least two frames");
  const stride = Math.max(1, Math.round((frames.length - 1) / 16));
  let dx = 0, dy = 0, panFit = 0, count = 0;
  for (let i = 0; i + stride < frames.length; i += stride) {
    const r = step(frames[i], frames[i + stride], width, height);
    dx += r.dx; dy += r.dy; panFit += r.panFit; count++;
  }
  /* Zoom is read between the first frame and one three quarters in: far apart enough for a slow zoom to show, close enough to still match. */
  const g = grow(frames[0], frames[Math.max(1, Math.round((frames.length - 1) * 0.75))], width, height);
  const zoom = g.zoom, zoomFit = g.zoomFit, still = g.still, pairs = 1;
  panFit /= count;
  /* The three are reported side by side: a move is judged on its own axis only, since a pan also looks a little like a zoom. */
  return {
    dx: round(dx / width), dy: round(dy / height), zoom: round(Math.exp(zoom) - 1),
    fit: round(Math.min(panFit, zoomFit)), still: round(still / pairs),
  };
}
const round = (v) => Math.round(v * 1000) / 1000;

/**
 * @param {{dx:number,dy:number,zoom:number}} measured
 * @param {keyof typeof EXPECTED} move
 */
export function cameraVerdict(measured, move) {
  const want = EXPECTED[move];
  if (!want) throw new Error(`Unknown camera move ${move}`);
  const key = "dx" in want ? "dx" : "dy" in want ? "dy" : "zoom";
  const sign = want[key];
  const got = measured[key] * sign;
  if (got >= MOVE_MIN) return { followed: true, reason: `${move} followed: ${key} ${measured[key]} (needs ${sign > 0 ? "+" : "-"}${MOVE_MIN} or more)` };
  const wrongWay = got <= -MOVE_MIN;
  return { followed: false, reason: wrongWay ? `${move} not followed: the picture moved the other way (${key} ${measured[key]})` : `${move} not followed: the picture hardly moved (${key} ${measured[key]}, needs ${MOVE_MIN})` };
}

/** Reads a clip with ffmpeg as small gray frames and measures its camera movement. */
export function measureCamera(file, { width = 96, run = execFileSync } = {}) {
  const probe = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file], { encoding: "utf8" })).streams[0];
  const height = Math.max(3, 2 * Math.round((width * probe.height) / probe.width / 2));
  const raw = run("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${width}:${height}:flags=area,format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 });
  const size = width * height, count = Math.floor(raw.length / size);
  const frames = Array.from({ length: count }, (_, i) => new Uint8Array(raw.buffer, raw.byteOffset + i * size, size));
  return analyseCamera(frames, width, height);
}

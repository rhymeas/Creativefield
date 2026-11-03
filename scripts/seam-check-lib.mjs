// Seam check: does a clip loop cleanly, and where is the best place to cut it so that it does?
//
// Ported from OpenField's "Seam Doctor" (wexloops/openfield, server/seam.ts, MIT, Copyright (c) 2026
// David Wexler / Strangeloop Studios) and, for judging a single join frame, from Body Double's
// per-segment QC (lucataco/open-source-higgsfield, bodydouble/qc.py seam_ratio, Apache-2.0).
// Only the measurement and the trim planning are taken; the LTX bridge and re-render fixes are not.
//
// Two distances on 8-bit luma decoded by ffmpeg:
//   composition  the largest difference of 8x8 tile means at 256 px wide. Catches a loop whose framing,
//                light or subject does not come back.
//   texture      mean absolute difference per pixel at 416 px wide. Catches clouds, water or grain that
//                jump at the wrap although the picture as a whole matches.
// Each distance at the wrap (last frame -> first frame) is divided by the clip's ordinary motion around
// the loop point, so a ratio of 1 means the wrap moves like any other frame step. A loop is seamless when
// both ratios are low, or when the jump is too small to see.
import { execFileSync } from "node:child_process";

export const SEAM_T = {
  /** A composition wrap smaller than this (tile levels) is invisible. */
  wrapInvisible: 3.0,
  /** Composition wrap / local motion at or below this is seamless. */
  seamless: 1.5,
  localFloor: 0.05,
  /** Texture wrap / local texture step at or below this is seamless. */
  textureSeamless: 2.0,
  /** A texture wrap under this many levels per pixel is invisible however still the clip is. */
  textureInvisible: 0.35,
  textureFloor: 0.08,
  minFrames: 8,
};
const TILES = 8, TILE_WIDTH = 256, TEXTURE_WIDTH = 416;

const run = (bin, args) => execFileSync(bin, args, { maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });

export function videoInfo(file) {
  const d = JSON.parse(run("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,width,height,r_frame_rate,nb_read_frames", "-of", "json", file]).toString());
  const v = (d.streams ?? []).find((s) => s.codec_type === "video");
  if (!v) throw new Error("the file has no picture");
  const [a, b] = String(v.r_frame_rate ?? "24/1").split("/").map(Number);
  return { w: v.width, h: v.height, fps: a && b ? a / b : 24, frames: Number(v.nb_read_frames) || 0 };
}

/** Every frame as 8-bit luma at `width` px wide (height keeps the aspect, even). */
function decodeGray(file, width, info) {
  const h = Math.max(2, 2 * Math.round((width * info.h) / info.w / 2)), size = width * h;
  const raw = run("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${width}:${h}:flags=area`, "-fps_mode", "passthrough", "-an", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  const frames = [];
  for (let k = 0; k + size <= raw.length; k += size) frames.push(new Uint8Array(raw.buffer, raw.byteOffset + k, size));
  return { w: width, h, frames };
}

export function tileVector(gray, w, h) {
  const th = Math.floor(h / TILES), tw = Math.floor(w / TILES), out = new Float32Array(TILES * TILES), area = th * tw;
  for (let ty = 0; ty < TILES; ty++) for (let tx = 0; tx < TILES; tx++) {
    let sum = 0;
    for (let y = ty * th; y < (ty + 1) * th; y++) for (let x = tx * tw; x < (tx + 1) * tw; x++) sum += gray[y * w + x];
    out[ty * TILES + tx] = sum / area;
  }
  return out;
}
export const tileDist = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
export const textureDist = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
export const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };
const round = (x, p = 100) => Math.round(x * p) / p;
/** The steps compared against the wrap. Step 0 is skipped: first/last-frame renders often jump right after the pinned frame. */
const localSteps = (n) => [1, 2, 3, n - 4, n - 3, n - 2].filter((i) => i >= 0 && i < n - 1);

export function load(file) {
  const info = videoInfo(file), a = decodeGray(file, TILE_WIDTH, info), b = decodeGray(file, TEXTURE_WIDTH, info), n = Math.min(a.frames.length, b.frames.length);
  if (n < SEAM_T.minFrames) throw new Error(`The clip is ${n} frames; the seam check needs at least ${SEAM_T.minFrames}.`);
  return { tiles: a.frames.slice(0, n).map((g) => tileVector(g, a.w, a.h)), tex: b.frames.slice(0, n), fps: info.fps, info };
}

const stepsOf = (L) => L.tex.slice(0, -1).map((f, i) => textureDist(f, L.tex[i + 1]));

/** Score the loop made of frames [start, end) of a loaded clip, wrap included, as a file holding just those frames would score. */
export function scoreWindow(L, start = 0, end = L.tex.length) {
  const n = end - start, texSteps = [], tileSteps = [];
  for (let i = start; i < end - 1; i++) { texSteps.push(textureDist(L.tex[i], L.tex[i + 1])); tileSteps.push(tileDist(L.tiles[i], L.tiles[i + 1])); }
  const loc = localSteps(n);
  const texWrap = textureDist(L.tex[end - 1], L.tex[start]), texLocal = Math.max(median(loc.map((i) => texSteps[i])), SEAM_T.textureFloor);
  const tileWrap = tileDist(L.tiles[end - 1], L.tiles[start]), tileLocal = Math.max(median(loc.map((i) => tileSteps[i])), SEAM_T.localFloor);
  const texture = { wrap: round(texWrap, 1000), local: round(texLocal, 1000), ratio: round(texWrap / texLocal) };
  const composition = { wrap: round(tileWrap, 1000), local: round(tileLocal, 1000), ratio: round(tileWrap / tileLocal) };
  const texOk = texWrap < SEAM_T.textureInvisible || texture.ratio <= SEAM_T.textureSeamless;
  const compOk = tileWrap < SEAM_T.wrapInvisible || composition.ratio <= SEAM_T.seamless;
  const ratio = compOk ? texture.ratio : Math.max(texture.ratio, composition.ratio);
  return { frames: n, fps: L.fps, verdict: texOk && compOk ? "seamless" : "visible", ratio: round(ratio), texture, composition };
}

/** The ratio of one internal step (frame - 1 -> frame) against the clip's ordinary texture step: judge a join inside a clip. */
export function spliceRatio(L, frame) {
  if (!(frame > 0 && frame < L.tex.length)) throw new Error(`Frame ${frame} is not inside the clip (1 to ${L.tex.length - 1}).`);
  const base = Math.max(median(stepsOf(L).slice(1)), SEAM_T.textureFloor);
  return round(textureDist(L.tex[frame - 1], L.tex[frame]) / base);
}

/**
 * The longest window [start, start + frames) that closes, judged by both scores exactly as the trimmed file will
 * be. Trims only, no blending. The window keeps at least max(2 s, half the clip).
 */
export function planTrim(L) {
  const n = L.tex.length, minLen = Math.min(n, Math.max(SEAM_T.minFrames, Math.round(Math.max(2, n / L.fps / 2) * L.fps)));
  const base = Math.max(median(stepsOf(L).slice(1)), SEAM_T.textureFloor);
  for (let len = n - 1; len >= minLen; len--) {
    let best = null;
    for (let s = 0; s + len <= n; s++) {
      if (textureDist(L.tex[s + len - 1], L.tex[s]) > SEAM_T.textureSeamless * 1.25 * base) continue;
      const m = scoreWindow(L, s, s + len);
      if (m.verdict === "seamless" && (!best || m.ratio < best.predicted.ratio)) best = { start: s, frames: len, predicted: m };
    }
    if (best) return best;
  }
  return null;
}

/*
 * The resolution pyramid for reference analysis: one FFmpeg decode of the clip
 * writes the two proxies the later stages read AND scans for hard cuts, so a cold
 * analysis pays a single decode, not three.
 *
 *   input ── split=3 ─┬─ scale=320 ──▶ proxy-320.mp4   (decision frames)
 *                     ├─ scale=640 ──▶ proxy-640.mp4   (geometry stills/clips)
 *                     └─ scdet=8   ──▶ null            (lavfi.scd.time in stderr)
 *
 * Then the 320 proxy is decoded once to a 48x27 grey rawvideo stream. Each sample
 * yields its mean luminance, contrast and structural change; blank samples
 * (near-black, near-white, flat) and the fade/cut transition samples beside them
 * are never keyframes and never motion peaks, so the deterministic keyframe
 * choice is start = first usable sample, middle = usable sample nearest the shot
 * centre, end = last usable sample, plus honest motion peaks. Nothing in the
 * pipeline re-reads the original after the one decode pass.
 *
 * The cache is content-addressed: `.comfyfield/analysis/<sha256>/` holds the
 * proxies, the decision JPEGs, the geometry stills/clips later stages write, and
 * a meta.json with the clip facts, shot keyframes and artifact names, so a later
 * stage never has to probe the clip again.
 *
 * Everything that can be pure is exported separately (cut parsing, shot bounds,
 * keyframe choice, luminance energy, select expressions) so the tests can run
 * without FFmpeg.
 */
import {createHash, randomUUID} from "node:crypto";
import {createWriteStream} from "node:fs";
import {mkdir, readFile, rm, stat, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {Transform, type Readable} from "node:stream";
import {pipeline} from "node:stream/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {DEFAULT_ANALYSIS_PARAMS, type AnalysisArtifacts, type AnalysisParams, type AnalysisShot, type ClipFacts, type KeyframeRole, type ShotKeyframe} from "../src/film-studio/analysis-contract";

const execute = promisify(execFile);

export const CUT_THRESHOLD = 8;
export const MAX_CUTS = 256;
export const MIN_SHOT_SEC = 0.2;
/** The luminance pass decodes at this grid; 48x27 keeps a 3 s clip's pass tiny and motion readable. */
export const MOTION_WIDTH = 48;
export const MOTION_HEIGHT = 27;
export const DEFAULT_JPEG_QUALITY = 5;
export const DEFAULT_SHOT_CLIP_SEC = 1.5;
/** A usable sample is neither near-black, near-white nor flat (values are 0..255 grey levels). */
export const BLACK_LUMA = 12;
export const WHITE_LUMA = 243;
export const MIN_CONTRAST = 4;
/** Samples this close to a blank sample are fade/cut transitions, never keyframes. */
export const BLANK_GUARD = 1;
/** Structural change below this is compression noise, not motion worth a keyframe. */
export const MIN_MOTION_ENERGY = 0.02;

/** FFmpeg/FFprobe could not be started; the route answers 503, not a 422. */
export class PyramidToolUnavailableError extends Error {}
/** The clip is not a readable video, or a filter refused it. */
export class PyramidAnalysisError extends Error {}

export function ffmpegCommand(): string {
  return process.env.FFMPEG_PATH ?? "ffmpeg";
}

export function ffprobeCommand(): string {
  return process.env.FFPROBE_PATH ?? "ffprobe";
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------------------------------------------------------------------------
 * Cache directory: content addressed, validated, one directory per clip SHA-256.
 * ---------------------------------------------------------------------------------------------- */

/** Root of the analysis cache; .comfyfield is gitignored and never published. */
export function analysisCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMFYFIELD_ANALYSIS_ROOT?.trim() ? env.COMFYFIELD_ANALYSIS_ROOT.trim() : join(process.cwd(), ".comfyfield", "analysis");
}

const SHA256 = /^[0-9a-f]{64}$/;

/** The directory for one clip. An invalid hash is a programming error, never a path. */
export function analysisCacheDir(sha256: string, root = analysisCacheRoot()): string {
  if (!SHA256.test(sha256)) throw new Error("Analysis cache is keyed by the clip's lowercase SHA-256 hex digest.");
  return join(root, sha256);
}

/** Proxy file names live beside the clip hash but encode the parameter that produced them. */
export function proxyFileNames(params: AnalysisParams = DEFAULT_ANALYSIS_PARAMS): AnalysisArtifacts {
  return {
    decisionProxy: `proxy-${params.pyramid.decisionWidth}.mp4`,
    geometryProxy: `proxy-${params.pyramid.geometryWidth}.mp4`,
  };
}

/** Create the cache directory (and parents) for one clip; returns the absolute path. */
export async function ensureAnalysisCacheDir(sha256: string, root = analysisCacheRoot()): Promise<string> {
  const dir = analysisCacheDir(sha256, root);
  await mkdir(dir, {recursive: true});
  return dir;
}

export type CachedArtifacts = {dir: string; decisionProxy: string; geometryProxy: string};

/**
 * The proxies a later stage needs, or null when the cache directory was cleaned.
 * Artifact names come from meta.json so a parameter change cannot point at the
 * wrong proxy.
 */
export async function presentAnalysisArtifacts(sha256: string, params: AnalysisParams | null = DEFAULT_ANALYSIS_PARAMS): Promise<CachedArtifacts | null> {
  let dir: string;
  try {
    dir = analysisCacheDir(sha256);
  } catch {
    return null;
  }
  const meta = await readAnalysisMeta(dir);
  const names = meta?.artifacts ?? proxyFileNames(params ?? DEFAULT_ANALYSIS_PARAMS);
  const decisionProxy = join(dir, names.decisionProxy);
  const geometryProxy = join(dir, names.geometryProxy);
  const present = async (path: string) => stat(path).then((info) => info.isFile() && info.size > 0).catch(() => false);
  if (!(await present(decisionProxy)) || !(await present(geometryProxy))) return null;
  return {dir, decisionProxy, geometryProxy};
}

/* ------------------------------------------------------------------------------------------------
 * Streaming upload: the SHA-256 is computed while the bytes are written, so the
 * cache key exists before any decode starts and a cache hit never runs FFmpeg.
 * ---------------------------------------------------------------------------------------------- */

export type SavedUpload = {path: string; sha256: string; bytes: number};

const UPLOAD_EXTENSIONS: Record<string, string> = {".mp4": ".mp4", ".webm": ".webm", ".mov": ".mov", ".m4v": ".m4v", ".mkv": ".mkv", ".avi": ".avi"};

/**
 * Stream one upload to a temporary file and hash it in the same pass. The caller
 * owns the file and must delete it (a cache hit never needs it again).
 */
export async function saveUploadToTemp(stream: Readable, filename: string, options: {tmpDir?: string; maxBytes?: number} = {}): Promise<SavedUpload> {
  const extension = UPLOAD_EXTENSIONS[(filename.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase()] ?? ".mp4";
  const tmpDir = options.tmpDir ?? join(process.cwd(), ".comfyfield", "tmp");
  await mkdir(tmpDir, {recursive: true});
  const path = join(tmpDir, `reference-analysis-${randomUUID()}${extension}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const limit = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit) {
        callback(new PyramidAnalysisError("The reference clip is larger than this server accepts."));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(stream, meter, createWriteStream(path));
  } catch (error) {
    await rm(path, {force: true}).catch(() => undefined);
    throw error;
  }
  return {path, sha256: hash.digest("hex"), bytes};
}

/* ------------------------------------------------------------------------------------------------
 * Probe: clip facts without decoding frames.
 * ---------------------------------------------------------------------------------------------- */

export type ClipProbe = {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
};

type FfprobeStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  nb_frames?: string;
  tags?: {rotate?: string};
  side_data_list?: Array<{rotation?: number}>;
};

/** `30000/1001` -> 29.97; empty/invalid -> 0. */
export function parseFrameRate(value: string | undefined): number {
  if (!value) return 0;
  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) return 0;
  const rate = Number(match[1]) / Number(match[2]);
  return Number.isFinite(rate) && rate > 0 && rate < 1000 ? rate : 0;
}

/** Read duration, display size and frame rate; auto-rotation swaps portrait dimensions. */
export async function probeClip(file: string, timeoutMs = 30_000): Promise<ClipProbe> {
  let stdout: string;
  try {
    const result = await execute(ffprobeCommand(), ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], {timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true});
    stdout = String(result.stdout);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES") throw new PyramidToolUnavailableError("Reference analysis needs FFprobe on the team server (set FFPROBE_PATH).");
    const stderr = String((error as {stderr?: string | Buffer}).stderr ?? "").trim();
    throw new PyramidAnalysisError(`The reference clip is not a readable video${stderr ? `: ${stderr.split(/\r?\n/).pop()}` : "."}`);
  }
  let data: {streams?: FfprobeStream[]; format?: {duration?: string}};
  try {
    data = JSON.parse(stdout) as {streams?: FfprobeStream[]; format?: {duration?: string}};
  } catch {
    throw new PyramidAnalysisError("The reference clip could not be probed.");
  }
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const durationSec = Number(data.format?.duration);
  if (!video?.width || !video.height || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new PyramidAnalysisError("The reference clip has no readable video stream.");
  }
  const rotation = video.side_data_list?.find((item) => typeof item.rotation === "number")?.rotation ?? Number(video.tags?.rotate ?? 0);
  const portrait = Number.isFinite(rotation) && Math.abs(Math.round(rotation / 90) % 2) === 1;
  const width = portrait ? video.height : video.width;
  const height = portrait ? video.width : video.height;
  const fps = parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate) || 25;
  const declaredFrames = Number(video.nb_frames);
  return {
    durationSec,
    width,
    height,
    fps,
    frameCount: Number.isFinite(declaredFrames) && declaredFrames > 0 ? Math.floor(declaredFrames) : Math.max(1, Math.round(durationSec * fps)),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Cut scan parsing and shot bounds.
 * ---------------------------------------------------------------------------------------------- */

/** FFmpeg's scdet filter logs one `lavfi.scd.time:` line per detected change. */
export function parseScdetTimes(log: string, maxCuts = MAX_CUTS): number[] {
  const times: number[] = [];
  for (const match of log.matchAll(/lavfi\.scd\.time:\s*([0-9]+(?:\.[0-9]+)?)/g)) {
    const time = Number(match[1]);
    if (Number.isFinite(time) && time > 0) times.push(round3(time));
  }
  return [...new Set(times)].sort((left, right) => left - right).slice(0, maxCuts);
}

/** Sorted, deduplicated cut times strictly inside the clip; near-edge changes are not shot boundaries. */
export function normalizeCutTimes(durationSec: number, cuts: readonly number[], maxCuts = MAX_CUTS): number[] {
  const end = Math.max(MIN_SHOT_SEC, durationSec);
  const normalized: number[] = [];
  for (const cut of [...cuts].sort((left, right) => left - right)) {
    const time = round3(cut);
    if (!Number.isFinite(time) || time <= MIN_SHOT_SEC || time >= end - MIN_SHOT_SEC) continue;
    const previous = normalized[normalized.length - 1];
    if (previous !== undefined && time - previous < 0.15) continue;
    if (normalized.length >= maxCuts) break;
    normalized.push(time);
  }
  return normalized;
}

export type ShotBounds = {startSec: number; endSec: number};

/** The shot list from cut times; always at least one shot covering the whole clip. */
export function shotsFromCuts(durationSec: number, cuts: readonly number[]): ShotBounds[] {
  const end = Math.max(MIN_SHOT_SEC, durationSec);
  const inside = normalizeCutTimes(end, cuts);
  const bounds = [0, ...inside, end];
  return bounds.slice(1).map((stop, index) => ({startSec: bounds[index], endSec: stop}));
}

/* ------------------------------------------------------------------------------------------------
 * Motion and blank sampling: luminance, contrast and structural change per 48x27 grey frame.
 * ---------------------------------------------------------------------------------------------- */

/** One sampled proxy frame: how bright it is, how much detail it has, and how much it changed. */
export type LumaSample = {
  /** Mean grey level, 0..255. */
  mean: number;
  /** Standard deviation of the frame; 0 for a flat (blank or fully faded) sample. */
  contrast: number;
  /** Structural change against the previous sample, 0..1; 0 when either sample is blank. */
  energy: number;
};

/** A sample that may carry a keyframe: not near-black, not near-white and not flat. */
export function sampleUsable(sample: LumaSample): boolean {
  return sample.mean >= BLACK_LUMA && sample.mean <= WHITE_LUMA && sample.contrast >= MIN_CONTRAST;
}

/**
 * Per-sample luma statistics from the 48x27 grey rawvideo stream.
 *
 * `energy` is structural change from the previous sample (1 - normalised cross
 * correlation), not a raw luminance difference: a fade scales a frame's
 * brightness uniformly, so its structure stays the same and it cannot fake a
 * motion peak. A sample next to a blank one has no energy either, so black cut
 * frames cannot fabricate one.
 */
export function sampleLuma(frames: Buffer, frameBytes = MOTION_WIDTH * MOTION_HEIGHT): LumaSample[] {
  const count = Math.floor(frames.length / frameBytes);
  const means = new Float64Array(count);
  const contrasts = new Float64Array(count);
  const usable = new Array<boolean>(count).fill(false);
  for (let frame = 0; frame < count; frame++) {
    const offset = frame * frameBytes;
    let sum = 0;
    let sumSquares = 0;
    for (let pixel = 0; pixel < frameBytes; pixel++) {
      const value = frames[offset + pixel];
      sum += value;
      sumSquares += value * value;
    }
    const mean = sum / frameBytes;
    const contrast = Math.sqrt(Math.max(0, sumSquares / frameBytes - mean * mean));
    means[frame] = mean;
    contrasts[frame] = contrast;
    usable[frame] = mean >= BLACK_LUMA && mean <= WHITE_LUMA && contrast >= MIN_CONTRAST;
  }
  const samples: LumaSample[] = [];
  for (let frame = 0; frame < count; frame++) {
    let energy = 0;
    if (frame > 0 && usable[frame] && usable[frame - 1]) {
      const previous = (frame - 1) * frameBytes;
      const current = frame * frameBytes;
      let dot = 0;
      for (let pixel = 0; pixel < frameBytes; pixel++) dot += frames[previous + pixel] * frames[current + pixel];
      const covariance = dot / frameBytes - means[frame - 1] * means[frame];
      const ncc = covariance / (contrasts[frame - 1] * contrasts[frame]);
      energy = Math.min(1, Math.max(0, 1 - ncc));
    }
    // Rounded so the same bytes always yield the same numbers on every platform.
    samples.push({
      mean: Math.round(means[frame] * 10) / 10,
      contrast: Math.round(contrasts[frame] * 10) / 10,
      energy: Math.round(energy * 10_000) / 10_000,
    });
  }
  return samples;
}

/** One 48x27 grey rawvideo pass over the decision proxy; the small proxy decodes in well under a second. */
export async function extractLumaSamples(input: {proxyPath: string; fps: number; timeoutMs?: number}): Promise<{samples: LumaSample[]; fps: number; frameCount: number}> {
  let result: {stdout: Buffer};
  try {
    result = (await execute(ffmpegCommand(), [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-i", input.proxyPath,
      "-an", "-vf", `scale=${MOTION_WIDTH}:${MOTION_HEIGHT}:flags=area,format=gray`,
      "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
    ], {encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: input.timeoutMs ?? 120_000, windowsHide: true})) as unknown as {stdout: Buffer};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES") throw new PyramidToolUnavailableError("Reference analysis needs FFmpeg on the team server (set FFMPEG_PATH).");
    throw new PyramidAnalysisError("The decision proxy could not be decoded for motion.");
  }
  const frameBytes = MOTION_WIDTH * MOTION_HEIGHT;
  const frameCount = Math.floor(result.stdout.length / frameBytes);
  if (!frameCount) throw new PyramidAnalysisError("The decision proxy contained no frames.");
  return {samples: sampleLuma(result.stdout, frameBytes), fps: input.fps > 0 ? input.fps : 25, frameCount};
}

/* ------------------------------------------------------------------------------------------------
 * Deterministic keyframe choice: first usable start, usable nearest the centre, last usable end,
 * then only honest motion peaks.
 * ---------------------------------------------------------------------------------------------- */

export type KeyframeChoiceInput = {
  startSec: number;
  endSec: number;
  fps: number;
  frameCount: number;
  /** Per-sample luminance, contrast and structural change from sampleLuma(). */
  samples: readonly LumaSample[];
  /** The cap from params.pyramid.keyframesPerShot. */
  perShot: number;
};

function clampFrame(frame: number, lastFrame: number): number {
  return clamp(Math.round(frame), 0, lastFrame);
}

function usableFrame(samples: readonly LumaSample[], frame: number): boolean {
  const sample = samples[frame];
  return !!sample && sampleUsable(sample);
}

/** A sample next to a blank one belongs to a fade or a cut transition, not to the shot. */
function transitionFrame(samples: readonly LumaSample[], frame: number): boolean {
  for (let distance = 1; distance <= BLANK_GUARD; distance++) {
    if (samples[frame - distance] !== undefined && !sampleUsable(samples[frame - distance])) return true;
    if (samples[frame + distance] !== undefined && !sampleUsable(samples[frame + distance])) return true;
  }
  return false;
}

/**
 * Pure and deterministic. The roles are honest: `start` is the first usable
 * sample inside the shot, `middle` the usable sample nearest the shot's centre
 * and `end` the last usable sample; motion peaks are only extra frames with role
 * "motion". Blank or transition samples never become keyframes, so a black cut
 * frame or a faded frame is not emitted; a shot with no usable sample returns no
 * keyframes at all (the studio shows "no keyframe" instead of measuring garbage).
 */
export function chooseShotKeyframes(input: KeyframeChoiceInput): ShotKeyframe[] {
  const fps = Number.isFinite(input.fps) && input.fps > 0 ? input.fps : 25;
  const availableFrames = Math.max(0, Math.floor(input.frameCount || input.samples.length));
  const lastFrame = Math.max(0, availableFrames - 1);
  const startFrame = clampFrame(input.startSec * fps, lastFrame);
  const endFrame = Math.max(startFrame, clampFrame(Math.ceil(input.endSec * fps) - 1, lastFrame));
  const perShot = Math.max(0, Math.floor(input.perShot));
  if (!perShot) return [];
  const usable: number[] = [];
  const clean: number[] = [];
  for (let frame = startFrame; frame <= endFrame; frame++) {
    if (!usableFrame(input.samples, frame)) continue;
    usable.push(frame);
    if (!transitionFrame(input.samples, frame)) clean.push(frame);
  }
  const pool = clean.length ? clean : usable;
  if (!pool.length) return [];
  let middle = pool[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  const centre = (startFrame + endFrame) / 2;
  for (const frame of pool) {
    const distance = Math.abs(frame - centre);
    // Ties (an even-sized shot split down the middle) go to the later frame,
    // matching the rounded centre and keeping the choice deterministic.
    if (distance < bestDistance || (distance === bestDistance && frame > middle)) {
      bestDistance = distance;
      middle = frame;
    }
  }
  const start = pool[0];
  const end = pool[pool.length - 1];
  const priority: Array<{frame: number; role: KeyframeRole}> = perShot >= 3
    ? [{frame: middle, role: "middle"}, {frame: start, role: "start"}, {frame: end, role: "end"}]
    : perShot === 2
      ? [{frame: middle, role: "middle"}, {frame: start, role: "start"}]
      : [{frame: middle, role: "middle"}];
  const chosen: Array<{frame: number; role: KeyframeRole}> = [];
  for (const candidate of priority) {
    if (chosen.length >= perShot) break;
    if (!chosen.some((item) => item.frame === candidate.frame)) chosen.push(candidate);
  }
  if (chosen.length < perShot) {
    const margin = Math.max(1, Math.round(fps * 0.12));
    const candidates = (clean.length ? clean : usable).filter((frame) => {
      const energy = input.samples[frame]?.energy ?? 0;
      if (energy < MIN_MOTION_ENERGY) return false;
      return chosen.every((item) => Math.abs(item.frame - frame) >= margin);
    });
    candidates.sort((left, right) => {
      const difference = (input.samples[right]?.energy ?? 0) - (input.samples[left]?.energy ?? 0);
      return difference !== 0 ? difference : left - right;
    });
    for (const frame of candidates) {
      if (chosen.length >= perShot) break;
      chosen.push({frame, role: "motion"});
    }
  }
  return chosen
    .sort((left, right) => left.frame - right.frame)
    .map((item) => ({index: item.frame, timeSec: round3(item.frame / fps), role: item.role}));
}

/* ------------------------------------------------------------------------------------------------
 * ONE decode pass: two proxies + the cut scan from the same FFmpeg invocation.
 * ---------------------------------------------------------------------------------------------- */

export type PyramidRun = {
  /** The `split -> scale,scale,scdet -> file,file,null` invocation. */
  passMs: number;
  cuts: number[];
  dir: string;
  decisionProxy: string;
  geometryProxy: string;
};

/** The filter graph is one split with three consumers; the scdet output is discarded with -f null. */
export function pyramidFilterGraph(params: AnalysisParams): string {
  const decisionWidth = Math.max(2, Math.floor(params.pyramid.decisionWidth));
  const geometryWidth = Math.max(2, Math.floor(params.pyramid.geometryWidth));
  return [
    `[0:v]split=3[p0][p1][p2]`,
    `[p0]scale=${decisionWidth}:-2:flags=bicubic[v0]`,
    `[p1]scale=${geometryWidth}:-2:flags=bicubic[v1]`,
    `[p2]scdet=threshold=${CUT_THRESHOLD}[v2]`,
  ].join(";");
}

function toolFailure(error: unknown): PyramidToolUnavailableError | PyramidAnalysisError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "EACCES") return new PyramidToolUnavailableError("Reference analysis needs FFmpeg on the team server (set FFMPEG_PATH).");
  const stderr = String((error as {stderr?: string | Buffer}).stderr ?? "").trim();
  const lastLine = stderr.split(/\r?\n/).filter(Boolean).pop();
  return new PyramidAnalysisError(`The reference clip could not be decoded${lastLine ? `: ${lastLine}` : "."}`);
}

/**
 * Decode the clip once and write both proxies while scdet logs the cuts. A clip
 * whose scdet pass ends with a non-zero code but whose proxies were written is
 * still usable: the cuts it logged before failing are returned.
 */
export async function encodePyramid(input: {sourcePath: string; dir: string; params: AnalysisParams; timeoutMs?: number}): Promise<PyramidRun> {
  await mkdir(join(input.dir, "decision"), {recursive: true});
  const names = proxyFileNames(input.params);
  const decisionProxy = join(input.dir, names.decisionProxy);
  const geometryProxy = join(input.dir, names.geometryProxy);
  const startedAt = Date.now();
  let stderr = "";
  try {
    const result = await execute(ffmpegCommand(), [
      "-hide_banner", "-nostats", "-nostdin", "-y",
      "-i", input.sourcePath,
      "-filter_complex", pyramidFilterGraph(input.params),
      "-map", "[v0]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart", decisionProxy,
      "-map", "[v1]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart", geometryProxy,
      "-map", "[v2]", "-an", "-f", "null", "-",
    ], {timeout: input.timeoutMs ?? 600_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true});
    stderr = String(result.stderr ?? "");
  } catch (error) {
    stderr = String((error as {stderr?: string | Buffer}).stderr ?? "");
    const proxiesWritten = await Promise.all([stat(decisionProxy).then(() => true).catch(() => false), stat(geometryProxy).then(() => true).catch(() => false)]);
    if (!proxiesWritten.every(Boolean)) throw toolFailure(error);
  }
  const passMs = Date.now() - startedAt;
  return {passMs, cuts: parseScdetTimes(stderr), dir: input.dir, decisionProxy, geometryProxy};
}

/* ------------------------------------------------------------------------------------------------
 * Frame-accurate JPEG extraction (decision data URLs and geometry stills).
 * ---------------------------------------------------------------------------------------------- */

/** `[3, 7, 8]` -> `eq(n\,3)+eq(n\,7)+eq(n\,8)`; the comma must be escaped for the filter parser. */
export function selectFrameExpression(indices: readonly number[]): string {
  return [...new Set(indices)].sort((left, right) => left - right).map((index) => `eq(n\\,${Math.max(0, Math.floor(index))})`).join("+");
}

/**
 * Extract the chosen frames of the decision proxy as JPEG data URLs, in one
 * FFmpeg invocation. The returned map is keyed by the proxy frame index.
 */
export async function extractFramesAsDataUrls(input: {proxyPath: string; frameIndices: readonly number[]; dir: string; quality?: number; timeoutMs?: number}): Promise<Map<number, string>> {
  const indices = [...new Set(input.frameIndices.filter((index) => Number.isFinite(index) && index >= 0).map((index) => Math.floor(index)))].sort((left, right) => left - right);
  const frames = new Map<number, string>();
  if (!indices.length) return frames;
  const outDir = join(input.dir, "decision");
  await mkdir(outDir, {recursive: true});
  const pattern = join(outDir, "frame-%04d.jpg");
  try {
    await execute(ffmpegCommand(), [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", input.proxyPath,
      "-vf", `select=${selectFrameExpression(indices)}`,
      "-fps_mode", "vfr", "-frames:v", String(indices.length),
      "-q:v", String(input.quality ?? DEFAULT_JPEG_QUALITY),
      "-start_number", "0", pattern,
    ], {timeout: input.timeoutMs ?? 180_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true});
  } catch (error) {
    throw toolFailure(error);
  }
  for (const [order, index] of indices.entries()) {
    const file = join(outDir, `frame-${String(order).padStart(4, "0")}.jpg`);
    try {
      frames.set(index, `data:image/jpeg;base64,${(await readFile(file)).toString("base64")}`);
    } catch {
      // A missing frame is dropped; the shot still has its other keyframes.
    }
  }
  return frames;
}

export type ExtractedStill = {path: string; bytes: number};

const stillName = (timeSec: number) => `still-${round3(timeSec).toFixed(3).replace(".", "_")}s.jpg`;

/**
 * One frame at `timeSec` as a JPEG. Defaults to `stills/` beside the geometry
 * proxy and the geometry width, which is what the geometry pass measures.
 */
export async function extractKeyframeStill(input: {geometryProxy: string; timeSec: number; outPath?: string; width?: number; quality?: number; timeoutMs?: number}): Promise<ExtractedStill> {
  const outPath = input.outPath ?? join(dirname(input.geometryProxy), "stills", stillName(input.timeSec));
  await mkdir(dirname(outPath), {recursive: true});
  const scale = input.width && input.width > 0 ? ["-vf", `scale=${Math.max(2, Math.floor(input.width))}:-2:flags=bicubic`] : [];
  try {
    await execute(ffmpegCommand(), [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-ss", String(Math.max(0, input.timeSec)),
      "-i", input.geometryProxy,
      ...scale,
      "-frames:v", "1", "-q:v", String(input.quality ?? 2), outPath,
    ], {timeout: input.timeoutMs ?? 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true});
  } catch (error) {
    throw toolFailure(error);
  }
  const info = await stat(outPath);
  return {path: outPath, bytes: info.size};
}

/**
 * A short 640-class clip of one shot, for the person/SAM pass. It is cut from
 * the geometry proxy, so the person pass never reads the original file.
 */
export async function extractShotClip(input: {geometryProxy: string; startSec: number; endSec: number; outPath?: string; width?: number; maxDurationSec?: number; timeoutMs?: number}): Promise<{path: string; bytes: number; startSec: number; endSec: number}> {
  const startSec = Math.max(0, input.startSec);
  const endSec = Math.max(startSec + 0.1, input.endSec);
  const duration = Math.min(endSec - startSec, Math.max(0.2, input.maxDurationSec ?? DEFAULT_SHOT_CLIP_SEC));
  const outPath = input.outPath ?? join(dirname(input.geometryProxy), "clips", `shot-${round3(startSec).toFixed(3).replace(".", "_")}s-${round3(endSec).toFixed(3).replace(".", "_")}s.mp4`);
  await mkdir(dirname(outPath), {recursive: true});
  const scale = input.width && input.width > 0 ? ["-vf", `scale=${Math.max(2, Math.floor(input.width))}:-2:flags=bicubic`] : [];
  try {
    await execute(ffmpegCommand(), [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-ss", String(startSec), "-i", input.geometryProxy,
      ...scale, "-t", String(duration),
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outPath,
    ], {timeout: input.timeoutMs ?? 180_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true});
  } catch (error) {
    throw toolFailure(error);
  }
  const info = await stat(outPath);
  return {path: outPath, bytes: info.size, startSec, endSec: startSec + duration};
}

/* ------------------------------------------------------------------------------------------------
 * meta.json: the durable record later stages read instead of probing the clip.
 * ---------------------------------------------------------------------------------------------- */

export type AnalysisMetaShot = {index: number; startSec: number; endSec: number; keyframes: ShotKeyframe[]};

export type AnalysisMeta = {
  version: 1;
  cacheKey: string;
  sha256: string;
  clip: ClipFacts;
  params: AnalysisParams;
  /** Proxy frame rate and count, so geometry maps a keyframe time to a proxy frame. */
  proxy: {fps: number; frameCount: number};
  shots: AnalysisMetaShot[];
  artifacts: AnalysisArtifacts;
  createdAt: string;
};

export function analysisMetaPath(dir: string): string {
  return join(dir, "meta.json");
}

export async function writeAnalysisMeta(dir: string, meta: AnalysisMeta): Promise<void> {
  await writeFile(analysisMetaPath(dir), JSON.stringify(meta), "utf8");
}

export async function readAnalysisMeta(dir: string): Promise<AnalysisMeta | null> {
  try {
    const parsed = JSON.parse(await readFile(analysisMetaPath(dir), "utf8")) as AnalysisMeta;
    return parsed && parsed.version === 1 && Array.isArray(parsed.shots) ? parsed : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------------------------------
 * The cold path: probe, one decode pass, luma/blank sampling, keyframes, artifacts.
 * ---------------------------------------------------------------------------------------------- */

export type PyramidBuildTimings = {
  probeMs: number;
  /** The one decode: both proxies plus the cut scan. */
  cutsMs: number;
  /** The 48x27 grey decode that samples luminance, contrast and structural change. */
  motionMs: number;
  /** The JPEG extraction of the decision frames. */
  framesMs: number;
  /** motion + frame extraction, the two keyframe stages together. */
  keyframesMs: number;
  totalMs: number;
};

export type PyramidBuild = {
  clip: ClipFacts;
  /** Shots with their keyframes and the decision JPEG data URLs aligned to them. */
  shots: AnalysisShot[];
  meta: AnalysisMeta;
  timings: PyramidBuildTimings;
};

/**
 * The cold scan: probe -> one decode (proxies + cuts) -> luma/blank samples ->
 * deterministic usable keyframes -> decision JPEGs -> meta.json. The original
 * clip is read exactly once, by the single FFmpeg decode.
 */
export async function buildAnalysisPyramid(input: {sourcePath: string; sha256: string; bytes: number; cacheKey: string; params: AnalysisParams; timeoutMs?: number}): Promise<PyramidBuild> {
  const startedAt = Date.now();
  const probeStarted = Date.now();
  const probe = await probeClip(input.sourcePath);
  const probeMs = Date.now() - probeStarted;
  const dir = await ensureAnalysisCacheDir(input.sha256);
  const pyramid = await encodePyramid({sourcePath: input.sourcePath, dir, params: input.params, timeoutMs: input.timeoutMs});
  const cuts = normalizeCutTimes(probe.durationSec, pyramid.cuts);
  const clip: ClipFacts = {
    sha256: input.sha256,
    bytes: input.bytes,
    durationSec: round3(probe.durationSec),
    width: probe.width,
    height: probe.height,
    fps: round3(probe.fps),
    aspectRatio: Math.round((probe.width / probe.height) * 1000) / 1000,
    cuts,
  };
  const lumaStarted = Date.now();
  // The proxy is the frame source for every later stage, so its own rate and
  // decoded frame count are what keyframe indices and geometry map against.
  const proxyProbe = await probeClip(pyramid.decisionProxy);
  const luma = await extractLumaSamples({proxyPath: pyramid.decisionProxy, fps: proxyProbe.fps, timeoutMs: input.timeoutMs});
  const lumaMs = Date.now() - lumaStarted;
  const bounds = shotsFromCuts(probe.durationSec, cuts);
  const selections = bounds.map((shot, index) => ({
    index,
    startSec: shot.startSec,
    endSec: shot.endSec,
    keyframes: chooseShotKeyframes({
      startSec: shot.startSec,
      endSec: shot.endSec,
      fps: luma.fps,
      frameCount: luma.frameCount,
      samples: luma.samples,
      perShot: input.params.pyramid.keyframesPerShot,
    }),
  }));
  const frameStarted = Date.now();
  const wanted = selections.flatMap((shot) => shot.keyframes.map((keyframe) => keyframe.index));
  const dataUrls = await extractFramesAsDataUrls({proxyPath: pyramid.decisionProxy, frameIndices: wanted, dir, timeoutMs: input.timeoutMs});
  const framesMs = Date.now() - frameStarted;
  const shots: AnalysisShot[] = selections.map((shot) => ({
    index: shot.index,
    startSec: round3(shot.startSec),
    endSec: round3(shot.endSec),
    keyframes: shot.keyframes,
    frames: shot.keyframes.map((keyframe) => dataUrls.get(keyframe.index) ?? ""),
  }));
  const artifacts = proxyFileNames(input.params);
  const meta: AnalysisMeta = {
    version: 1,
    cacheKey: input.cacheKey,
    sha256: input.sha256,
    clip,
    params: input.params,
    proxy: {fps: luma.fps, frameCount: luma.frameCount},
    shots: selections,
    artifacts,
    createdAt: new Date().toISOString(),
  };
  await writeAnalysisMeta(dir, meta);
  const keyframesMs = lumaMs + framesMs;
  return {
    clip,
    shots,
    meta,
    timings: {probeMs, cutsMs: pyramid.passMs, motionMs: lumaMs, framesMs, keyframesMs, totalMs: Date.now() - startedAt},
  };
}

/** Remove the temporary upload after a scan; a cache hit never needs it. */
export async function removeUploadedClip(path: string): Promise<void> {
  await rm(path, {force: true}).catch(() => undefined);
}

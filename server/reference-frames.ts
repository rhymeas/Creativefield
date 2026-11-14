/*
 * YouTube tab capture storage: the studio captures the embedded player
 * in real time and posts only keyframe stills - never a video file. This module
 * owns the deterministic capture directory so later stages (geometry) can read
 * the 640 px stills back without another capture:
 *
 *   .comfyfield/analysis/workspace-<workspaceId>/youtube-<videoId>/capture-<hash>/
 *     stills/shot-<index>-<role>-<time>s.jpg
 *     capture.json   (videoId, capture params, clip bounds, shot keyframes, file names)
 *
 * The directory is scoped by workspace AND by a hash of the analysis cache key
 * (which contains the video id plus the capture parameters and model versions):
 * two workspaces using the same YouTube video can never overwrite each other's
 * capture, and a re-capture with different capture parameters gets its own
 * folder. The cache key keeps the literal `youtube:<videoId>` token; the path
 * drops the colon (Windows) and the video id is validated before it is used.
 *
 * Nothing here decodes video: every still is a JPEG data URL from the browser,
 * checked for the data-URL shape, a size bound and the JPEG magic bytes before
 * it is written.
 */
import {createHash} from "node:crypto";
import {mkdir, readFile, stat, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {
  isYoutubeClipToken,
  type AnalysisCaptureParams,
  type AnalysisFrameScanRequest,
  type AnalysisFrameShot,
  type KeyframeRole,
  type ShotKeyframe,
} from "../src/film-studio/analysis-contract";
import {analysisCacheRoot} from "./reference-pyramid";

export const CAPTURE_META_FILE = "capture.json";
export const MAX_CAPTURE_STILL_BYTES = 2_000_000;
/** The message the geometry route reports per shot when its captured stills are gone. */
export const CAPTURE_STILLS_MISSING = "stills missing; capture again";

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const JPEG_DATA_URL = /^data:image\/jpeg;base64,([A-Za-z0-9+/=\s]+)$/;

/** A capture payload problem the route reports as 400/413, not a server failure. */
export class CaptureFrameError extends Error {}

export type CaptureClipFacts = AnalysisFrameScanRequest["clip"];

/** Filesystem scope for a capture; a YouTube capture always needs workspace + cache key. */
export type CaptureStorage = {root?: string; workspaceId?: string; cacheKey?: string};

export type CaptureStillFile = {timeSec: number; role: KeyframeRole; path: string};
export type CaptureShotStills = {shotIndex: number; stills: CaptureStillFile[]};

export type CaptureStoredMeta = {
  version: 1;
  cacheKey: string;
  videoId: string;
  capture: AnalysisCaptureParams;
  clip: CaptureClipFacts;
  shots: Array<{index: number; startSec: number; endSec: number; keyframes: ShotKeyframe[]}>;
  stills: Array<{shotIndex: number; stills: Array<{timeSec: number; role: KeyframeRole; file: string}>}>;
  createdAt: string;
};

/** Root of the capture directories; the same content-addressed root as file scans. */
export function captureCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return analysisCacheRoot(env);
}

/**
 * The capture directory for a cache token. A YouTube capture is scoped by
 * workspace and by a hash of its cache key (videoId + capture params + model
 * versions), so workspaces and capture variants never share stills. A file-clip
 * SHA-256 keeps its content-addressed directory.
 */
export function captureCacheDir(cacheToken: string, storage: CaptureStorage = {}): string {
  const root = storage.root ?? captureCacheRoot();
  if (isYoutubeClipToken(cacheToken)) {
    const videoId = cacheToken.slice("youtube:".length);
    if (!YOUTUBE_ID.test(videoId)) throw new CaptureFrameError("The YouTube id in the cache token is not valid.");
    const workspaceId = storage.workspaceId ?? "";
    if (!WORKSPACE_ID.test(workspaceId)) throw new CaptureFrameError("A captured analysis needs its workspace id for storage.");
    const cacheKey = storage.cacheKey ?? "";
    if (cacheKey.length < 8) throw new CaptureFrameError("A captured analysis needs its cache key for storage.");
    const captureHash = createHash("sha256").update(cacheKey).digest("hex").slice(0, 16);
    return join(root, `workspace-${workspaceId}`, `youtube-${videoId}`, `capture-${captureHash}`);
  }
  if (!SHA256.test(cacheToken)) throw new CaptureFrameError("Capture storage is keyed by a YouTube id or a clip SHA-256.");
  return join(root, cacheToken);
}

/** Decode one still; rejects anything that is not a reasonably sized JPEG data URL. */
export function decodeCaptureStill(dataUrl: string, maxBytes = MAX_CAPTURE_STILL_BYTES): Buffer {
  const match = JPEG_DATA_URL.exec(dataUrl);
  if (!match) throw new CaptureFrameError("Capture stills must be JPEG data URLs.");
  const bytes = Buffer.from(match[1], "base64");
  if (!bytes.length) throw new CaptureFrameError("A capture still is empty.");
  if (bytes.length > maxBytes) throw new CaptureFrameError("A capture still is too large.");
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new CaptureFrameError("A capture still is not a JPEG image.");
  return bytes;
}

/** Deterministic file name for one still; the time is fixed at three decimals. */
export function captureStillFileName(shotIndex: number, still: {timeSec: number; role: KeyframeRole}): string {
  return `shot-${shotIndex}-${still.role}-${still.timeSec.toFixed(3).replace(".", "_")}s.jpg`;
}

/**
 * Write every captured 640 still and the capture manifest. Idempotent: a second
 * call for the same video overwrites the same files (a re-capture or a cache hit
 * heals a cleaned directory).
 */
export async function saveCaptureStills(input: {
  cacheToken: string;
  cacheKey: string;
  /** Who owns the capture; required for YouTube tokens so workspaces stay separated. */
  workspaceId: string;
  videoId: string;
  capture: AnalysisCaptureParams;
  clip: CaptureClipFacts;
  shots: AnalysisFrameShot[];
  root?: string;
}): Promise<{dir: string; shots: CaptureShotStills[]; bytes: number; meta: CaptureStoredMeta}> {
  if (!input.shots.length) throw new CaptureFrameError("A captured analysis needs at least one shot.");
  const dir = captureCacheDir(input.cacheToken, {root: input.root, workspaceId: input.workspaceId, cacheKey: input.cacheKey});
  const stillDir = join(dir, "stills");
  await mkdir(stillDir, {recursive: true});
  let bytes = 0;
  const shots: CaptureShotStills[] = [];
  const metaShots: CaptureStoredMeta["stills"] = [];
  for (const shot of input.shots) {
    if (!shot.stills.length) throw new CaptureFrameError(`Shot ${shot.index} has no 640 still`);
    const stills: CaptureStillFile[] = [];
    for (const still of shot.stills) {
      const data = decodeCaptureStill(still.dataUrl);
      const name = captureStillFileName(shot.index, still);
      const path = join(stillDir, name);
      await writeFile(path, data);
      bytes += data.length;
      stills.push({timeSec: still.timeSec, role: still.role, path});
    }
    shots.push({shotIndex: shot.index, stills});
    metaShots.push({shotIndex: shot.index, stills: shot.stills.map((still) => ({timeSec: still.timeSec, role: still.role, file: `stills/${captureStillFileName(shot.index, still)}`}))});
  }
  const meta: CaptureStoredMeta = {
    version: 1,
    cacheKey: input.cacheKey,
    videoId: input.videoId,
    capture: input.capture,
    clip: input.clip,
    shots: input.shots.map((shot) => ({index: shot.index, startSec: shot.startSec, endSec: shot.endSec, keyframes: shot.keyframes})),
    stills: metaShots,
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(dir, CAPTURE_META_FILE), JSON.stringify(meta), "utf8");
  return {dir, shots, bytes, meta};
}

export type CaptureReadResult = {
  dir: string;
  meta: CaptureStoredMeta | null;
  shots: CaptureShotStills[];
  /** Shots the manifest knows about whose still files no longer exist. */
  missingShotIndices: number[];
};

/**
 * Read the stored stills for a capture token. Files that disappeared are dropped
 * rather than reported as present, so the geometry route can answer per shot
 * "stills missing; capture again".
 */
export async function readCaptureStills(cacheToken: string, storage: CaptureStorage = {}): Promise<CaptureReadResult> {
  const dir = captureCacheDir(cacheToken, storage);
  let meta: CaptureStoredMeta | null = null;
  try {
    const parsed = JSON.parse(await readFile(join(dir, CAPTURE_META_FILE), "utf8")) as CaptureStoredMeta;
    meta = parsed && parsed.version === 1 && Array.isArray(parsed.stills) ? parsed : null;
  } catch {
    meta = null;
  }
  const shots: CaptureShotStills[] = [];
  const missingShotIndices: number[] = [];
  for (const entry of meta?.stills ?? []) {
    const stills: CaptureStillFile[] = [];
    for (const still of entry.stills) {
      const path = join(dir, still.file);
      const present = await stat(path).then((info) => info.isFile() && info.size > 0).catch(() => false);
      if (present) stills.push({timeSec: still.timeSec, role: still.role, path});
    }
    if (stills.length) shots.push({shotIndex: entry.shotIndex, stills});
    else missingShotIndices.push(entry.shotIndex);
  }
  return {dir, meta, shots, missingShotIndices};
}

/** The stills map the geometry stage consumes, keyed by shot index. */
export async function captureStillsByShot(cacheToken: string, storage: CaptureStorage = {}): Promise<{dir: string; byShot: Map<number, CaptureStillFile[]>}> {
  const read = await readCaptureStills(cacheToken, storage);
  return {dir: read.dir, byShot: new Map(read.shots.map((entry) => [entry.shotIndex, entry.stills]))};
}

/*
 * Browser helpers for the reference-analysis routes. The heavy stages (clip
 * scan, resolution pyramid, geometry) run on the team server; this module is the
 * one typed client for them, so a route change breaks the studio at compile time
 * instead of at runtime.
 *
 * The scan call uploads the clip as multipart (`params` JSON field first, then
 * the clip file, because the server reads the params while consuming the file
 * part) and the server answers with the whole AnalysisScan contract. The other
 * two calls are small JSON posts: geometry batches and the final score commit
 * that makes the next identical scan a cache hit.
 *
 * A captured YouTube analysis posts keyframe JPEGs instead of a clip
 * to `scan-frames`; the route answers with the same AnalysisScan, so the
 * decision/geometry/commit loop is shared with the upload path. A probe without
 * frames answers from the cache (a 400 "needs its keyframe stills" refusal means
 * "not analysed yet", see `isFrameScanCacheMiss`).
 *
 * No DOM-only API is used beyond fetch/FormData/Blob, so the module can also be
 * imported from tests. Every helper rejects with AnalysisClientError carrying
 * the HTTP status and the server's sentence for the UI's one Notice.
 */
import type {
  AnalysisCacheCommit,
  AnalysisCacheCommitResult,
  AnalysisFrameScanRequest,
  AnalysisParams,
  AnalysisScan,
  GeometryBatchRequest,
  GeometryBatchResult,
} from "./analysis-contract";

/** A route refusal the studio can show; `status` 0 means the request never completed. */
export class AnalysisClientError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AnalysisClientError";
    this.status = status;
  }
}

export type AnalysisRequestOptions = {
  /** Cancel a scan/geometry run when the reference changes. */
  signal?: AbortSignal;
  timeoutMs?: number;
};

const SCAN_TIMEOUT_MS = 600_000;
// A captured frame scan is a JSON body of keyframe JPEGs (at most 64 MB on the route) that only has
// to be written to disk and stored as a cache row; it never decodes video.
const FRAME_SCAN_TIMEOUT_MS = 300_000;
// Geometry batches are real MoGe-2/SAM 3.1 runs. On the installed fp32 build one 8-shot batch
// takes about 16 minutes, so the client waits well past that; the batch itself reports per-shot
// timeouts instead of letting the request die (a timeout keeps the shots already measured).
const GEOMETRY_TIMEOUT_MS = 1_800_000;
const CACHE_TIMEOUT_MS = 60_000;

function route(workspaceId: string, action: "scan" | "scan-frames" | "geometry" | "cache"): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/reference-analysis/${action}`;
}

/** The caller's signal plus a hard timeout; AbortSignal.any is used when the browser has it. */
function requestSignal(options: AnalysisRequestOptions | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options?.signal;
  if (!signal) return timeout;
  const anyOf = (AbortSignal as unknown as {any?: (signals: AbortSignal[]) => AbortSignal}).any;
  return typeof anyOf === "function" ? anyOf([signal, timeout]) : signal;
}

async function failure(response: Response): Promise<AnalysisClientError> {
  const payload = (await response.json().catch(() => null)) as {error?: unknown} | null;
  const message = typeof payload?.error === "string" && payload.error.trim() ? payload.error.trim() : `Reference analysis failed (${response.status}).`;
  return new AnalysisClientError(message, response.status);
}

/**
 * Upload one clip and get its reproducible analysis. The server identifies the
 * clip by SHA-256, so the same file and params always return the same score.
 */
export async function scanReferenceClip(
  workspaceId: string,
  clip: Blob,
  options: AnalysisRequestOptions & {params?: AnalysisParams; filename?: string} = {},
): Promise<AnalysisScan> {
  if (!clip.size) throw new AnalysisClientError("The clip could not be read.", 0);
  const form = new FormData();
  // Field order matters: fastify-multipart exposes `file.fields` once the file
  // part is reached, so the params part must come first.
  if (options.params) form.append("params", JSON.stringify(options.params));
  const filename = options.filename ?? (clip as File).name ?? "reference.mp4";
  form.append("file", clip, filename);
  let response: Response;
  try {
    response = await fetch(route(workspaceId, "scan"), {
      method: "POST",
      body: form,
      credentials: "same-origin",
      signal: requestSignal(options, options.timeoutMs ?? SCAN_TIMEOUT_MS),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new AnalysisClientError("The reference clip could not be uploaded to the server.", 0);
  }
  if (!response.ok) throw await failure(response);
  const payload = (await response.json().catch(() => null)) as (AnalysisScan & {error?: string}) | null;
  if (!payload || typeof payload.cacheKey !== "string" || !Array.isArray(payload.shots) || !payload.clip) {
    throw new AnalysisClientError("The server returned an incomplete analysis.", response.status);
  }
  return payload;
}

/**
 * Analyse a captured YouTube embed without a video file: the request
 * carries keyframe stills with their player-clock timestamps, never a clip.
 * The server stores the 640 stills (its geometry stage reads them back) and
 * answers with the same AnalysisScan shape as the upload path, so the studio's
 * decision/geometry/commit loop is shared. On a cache hit the request may omit
 * `shots` entirely: probing the cache never needs a capture.
 */
export async function scanReferenceFrames(
  workspaceId: string,
  request: AnalysisFrameScanRequest,
  options: AnalysisRequestOptions = {},
): Promise<AnalysisScan> {
  let response: Response;
  try {
    response = await fetch(route(workspaceId, "scan-frames"), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      credentials: "same-origin",
      body: JSON.stringify(request),
      signal: requestSignal(options, options.timeoutMs ?? FRAME_SCAN_TIMEOUT_MS),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new AnalysisClientError("The captured reference could not reach the analysis server.", 0);
  }
  if (!response.ok) throw await failure(response);
  const payload = (await response.json().catch(() => null)) as (AnalysisScan & {error?: string}) | null;
  if (!payload || typeof payload.cacheKey !== "string" || !Array.isArray(payload.shots) || !payload.clip) {
    throw new AnalysisClientError("The server returned an incomplete captured analysis.", response.status);
  }
  return payload;
}

/**
 * True when a frames-less cache probe was refused because the video has not
 * been analysed yet: the scan-frames route answers a first analysis without
 * stills with 400 "needs its keyframe stills", which is a cache miss, not a
 * failure. A hit answers 200 with the stored scan (possibly `cache.hit:false`
 * from a future server), so only the refusal is special.
 */
export function isFrameScanCacheMiss(error: unknown): boolean {
  return error instanceof AnalysisClientError && error.status === 400 && /keyframe stills|first analysis/i.test(error.message);
}

/** Measure a batch of shots (at most 8 per call, per shotBatches) on the analysis worker. */
export async function requestGeometryBatch(
  workspaceId: string,
  request: GeometryBatchRequest,
  options: AnalysisRequestOptions = {},
): Promise<GeometryBatchResult> {
  let response: Response;
  try {
    response = await fetch(route(workspaceId, "geometry"), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      credentials: "same-origin",
      body: JSON.stringify({cacheKey: request.cacheKey, shotIndices: request.shotIndices}),
      signal: requestSignal(options, options.timeoutMs ?? GEOMETRY_TIMEOUT_MS),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new AnalysisClientError("The geometry batch could not reach the analysis server.", 0);
  }
  if (!response.ok) throw await failure(response);
  const payload = (await response.json().catch(() => null)) as (GeometryBatchResult & {error?: string}) | null;
  if (!payload || !Array.isArray(payload.geometries) || !Array.isArray(payload.errors)) {
    throw new AnalysisClientError("The server returned an incomplete geometry batch.", response.status);
  }
  return payload;
}

/** Store the studio's decisions, geometries and score so the next identical scan is instant. */
export async function commitAnalysisCache(
  workspaceId: string,
  commit: AnalysisCacheCommit,
  options: AnalysisRequestOptions = {},
): Promise<AnalysisCacheCommitResult> {
  let response: Response;
  try {
    response = await fetch(route(workspaceId, "cache"), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      credentials: "same-origin",
      body: JSON.stringify(commit),
      signal: requestSignal(options, options.timeoutMs ?? CACHE_TIMEOUT_MS),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new AnalysisClientError("The analysis could not be stored on the server.", 0);
  }
  if (!response.ok) throw await failure(response);
  const payload = (await response.json().catch(() => null)) as (AnalysisCacheCommitResult & {error?: string}) | null;
  if (!payload || typeof payload.cacheKey !== "string" || typeof payload.stored !== "boolean") {
    throw new AnalysisClientError("The server returned an incomplete cache answer.", response.status);
  }
  return payload;
}

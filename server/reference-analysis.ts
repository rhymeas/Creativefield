/*
 * Reference analysis: read a reference video's frames with the workspace's own
 * image-capable text provider and return a scene plan the studio can turn into
 * a grey-block choreography. Uploaded clips are sampled in the browser and
 * posted as frames; a YouTube link only exposes its poster server-side, so the
 * poster is fetched here and the plan is a draft inferred from that frame.
 *
 * The model is asked for one strict JSON object; this route validates its shape
 * as far as it can and leaves the final normalization (clamps, defaults) to the
 * studio's score builder.
 *
 * The reproducible analysis routes live beside it, on the same contract module
 * the studio imports (src/film-studio/analysis-contract.ts):
 *
 *  POST .../reference-analysis/scan      multipart clip (+ optional params JSON)
 *                                        -> AnalysisScan; the clip is hashed while
 *                                        it is uploaded, so the same bytes always
 *                                        resolve to the same cache row and a full
 *                                        hit never runs FFmpeg.
 *  POST .../reference-analysis/geometry  {cacheKey, shotIndices}
 *                                        -> GeometryBatchResult; cached shots are
 *                                        returned without another GPU run.
 *  POST .../reference-analysis/cache     AnalysisCacheCommit
 *                                        -> AnalysisCacheCommitResult; the studio
 *                                        writes its score back so the next scan
 *                                        of the same clip is instant.
 *
 * YouTube tab capture runs the same pipeline without a video file: the
 * client captures the embedded player and posts keyframe stills instead of a
 * clip. The scan-frames route stores the 640 stills on disk (later stages read
 * them), keys the cache by videoId + capture params + models (no clip SHA is
 * possible) and answers with the same AnalysisScan shape, so the decisions and
 * geometry loops stay unchanged. The geometry route then feeds those stills to
 * the geometry stage in stills mode instead of a proxy clip.
 *
 * The old POST /reference-analysis endpoint stays unchanged for compatibility.
 */
import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {HttpError, member} from "./auth";
import {aiTextSettings, generateText, imageTextProvider, type AiTextImage} from "./ai-text";
import {
  ANALYSIS_CONTRACT_VERSION,
  DEFAULT_ANALYSIS_PARAMS,
  analysisCacheKey,
  isYoutubeClipToken,
  scoreHash,
  youtubeAnalysisCacheKey,
  youtubeClipToken,
  type AnalysisCacheCommitResult,
  type AnalysisCacheState,
  type AnalysisFrameScanRequest,
  type AnalysisParams,
  type AnalysisScan,
  type AnalysisShot,
  type AnalysisTimings,
  type ClipFacts,
  type GeometryBatchResult,
  type ShotDecision,
  type ShotGeometry,
  type ShotSkip,
} from "../src/film-studio/analysis-contract";
import {initialShotStatuses} from "../src/film-studio/shot-status";
import {MAX_SET_BLOCKS} from "../src/film-studio/geometry";
import {
  analysisCacheStage,
  analysisPending,
  readAnalysisCache,
  upsertAnalysisCache,
  type StoredAnalysis,
} from "./analysis-cache";
import {
  buildAnalysisPyramid,
  presentAnalysisArtifacts,
  PyramidAnalysisError,
  PyramidToolUnavailableError,
  removeUploadedClip,
  saveUploadToTemp,
} from "./reference-pyramid";
import {CAPTURE_STILLS_MISSING, CaptureFrameError, captureStillsByShot, saveCaptureStills} from "./reference-frames";
import {runGeometryBatch} from "./analysis-geometry";

const MAX_FRAMES = 8;
const MAX_FRAME_BYTES = 450_000;
const MAX_POSTER_BYTES = 1_500_000;
const MAX_CACHE_KEY_CHARS = 600;
const MAX_GEOMETRY_BATCH = 64;
const MAX_SCORE_CHARS = 8_000_000;
/**: captured scans are JSON with JPEG data URLs; the stills need a much larger body limit. */
const MAX_CAPTURE_SHOTS = 600;
const MAX_CAPTURE_STILLS_PER_SHOT = 3;
const MAX_CAPTURE_JPEG_CHARS = 4_000_000;
const CAPTURE_BODY_LIMIT = 64 * 1024 * 1024;
/**
 * The cache commit carries every shot's geometry with its rebuilt set (up to MAX_SET_BLOCKS boxes per
 * shot,) plus the score: an 88-shot film is several MB, far above the 1 MB app default.
 */
const CACHE_COMMIT_BODY_LIMIT = 64 * 1024 * 1024;
const base = "/api/v1/workspaces/:workspaceId";

const body = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
  frames: z.array(z.string().max(MAX_FRAME_BYTES * 2)).max(MAX_FRAMES).optional(),
  durationSec: z.number().positive().max(3600).optional(),
  aspectRatio: z.number().positive().max(10).optional(),
  cuts: z.array(z.number().min(0).max(3600)).max(64).optional(),
  shotIndices: z.array(z.number().int().min(0).max(120)).max(32).optional(),
  note: z.string().max(500).optional(),
}).strict();

const paramsSchema = z.object({
  version: z.number().int().min(1).max(1000),
  models: z.object({
    decision: z.string().min(1).max(200),
    geometry: z.string().min(1).max(300),
    persons: z.string().min(1).max(300),
  }),
  pyramid: z.object({
    decisionWidth: z.number().int().min(64).max(4096),
    geometryWidth: z.number().int().min(64).max(4096),
    keyframesPerShot: z.number().int().min(1).max(8),
  }),
});

/* ──: a captured YouTube analysis arrives as keyframe stills, not a clip file ── */

const captureRoleSchema = z.enum(["start", "middle", "end", "motion"]);
const captureJpegDataUrl = z.string().min(64).max(MAX_CAPTURE_JPEG_CHARS).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=\s]+$/);
const captureKeyframeSchema = z.object({
  index: z.number().int().min(0).max(1_000_000),
  timeSec: z.number().min(0).max(36_000),
  role: captureRoleSchema,
});
const captureStillSchema = z.object({
  timeSec: z.number().min(0).max(36_000),
  role: captureRoleSchema,
  dataUrl: captureJpegDataUrl,
});
const captureShotSchema = z.object({
  index: z.number().int().min(0).max(MAX_CAPTURE_SHOTS - 1),
  startSec: z.number().min(0).max(36_000),
  endSec: z.number().min(0).max(36_000),
  keyframes: z.array(captureKeyframeSchema).min(1).max(MAX_CAPTURE_STILLS_PER_SHOT),
  frames: z.array(captureJpegDataUrl).min(1).max(MAX_CAPTURE_STILLS_PER_SHOT),
  stills: z.array(captureStillSchema).min(1).max(MAX_CAPTURE_STILLS_PER_SHOT),
});
const frameScanBody = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  capture: z.object({
    fps: z.number().min(0.5).max(60),
    keyframes: z.number().int().min(1).max(MAX_CAPTURE_STILLS_PER_SHOT),
    section: z.object({startSec: z.number().min(0).max(36_000), endSec: z.number().min(0).max(36_000)}).refine((section) => section.endSec > section.startSec).optional(),
  }),
  clip: z.object({
    durationSec: z.number().min(0.2).max(36_000),
    width: z.number().int().min(16).max(8192),
    height: z.number().int().min(16).max(8192),
    aspectRatio: z.number().min(0.1).max(10),
  }),
  /** Omitted on a cache hit: the client only uploads frames on a miss. */
  shots: z.array(captureShotSchema).max(MAX_CAPTURE_SHOTS).optional(),
  params: paramsSchema.optional(),
});

const geometryBody = z.object({
  cacheKey: z.string().min(10).max(MAX_CACHE_KEY_CHARS),
  shotIndices: z.array(z.number().int().min(0).max(10_000)).min(1).max(MAX_GEOMETRY_BATCH),
});

const milliseconds = z.number().min(0).max(86_400_000);

const cacheTimings = z.object({
  hashMs: milliseconds,
  cutsMs: milliseconds,
  keyframesMs: milliseconds,
  decisionsMs: milliseconds,
  geometryMs: milliseconds,
  totalMs: milliseconds,
}).partial();

const shotDecisionSchema = z.object({
  shotIndex: z.number().int().min(0).max(10_000),
  people: z.number().int().min(0).max(64),
  size: z.enum(["wide", "medium", "close"]),
  motion: z.enum(["static", "dolly", "pan", "handheld"]),
  needsStaging: z.number().int().min(0).max(10_000),
});

const floorSchema = z.object({
  normal: z.tuple([z.number(), z.number(), z.number()]),
  offsetM: z.number(),
  inliers: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
});

const cameraSchema = z.object({
  heightM: z.number(),
  pitchDeg: z.number(),
  yawDeg: z.number(),
  fovDeg: z.number(),
  lensMm: z.number(),
  confidence: z.number().min(0).max(1),
});

const personTrackSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().max(200).optional(),
  heightM: z.number().min(0).max(10),
  keyframes: z.array(z.object({
    timeSec: z.number().min(0),
    xM: z.number(),
    zM: z.number(),
    confidence: z.number().min(0).max(1),
  })).max(500),
});

const shotGeometrySchema = z.object({
  shotIndex: z.number().int().min(0).max(10_000),
  floor: floorSchema,
  camera: cameraSchema,
  persons: z.array(personTrackSchema).max(50),
  source: z.object({
    model: z.string().min(1).max(300),
    keyframeSeconds: z.array(z.number().min(0)).max(64),
    runtimeMs: z.number().min(0),
  }),
  // Estimated geometry for shots without a usable floor; "measured" is the default.
  quality: z.enum(["measured", "estimated"]).optional(),
  estimate: z.object({
    basis: z.enum(["person-height", "head-size"]),
    anchorM: z.number().min(0).max(10),
    anchorPx: z.number().min(0),
    subjectDistanceM: z.number().min(0.05).max(200),
    cameraHeightSource: z.enum(["neighbor-floor", "eye-level", "person-feet", "person-head"]),
    neighborShotIndex: z.number().int().min(0).max(10_000).optional(),
    keyframeTimeSec: z.number().min(0),
  }).optional(),
  // The roughly rebuilt set: grey blocks in stage coordinates.
  set: z.array(z.object({
    xM: z.number().min(-500).max(500),
    yM: z.number().min(-5).max(100),
    zM: z.number().min(-500).max(500),
    sizeX: z.number().min(0.01).max(100),
    sizeY: z.number().min(0.01).max(100),
    sizeZ: z.number().min(0.01).max(100),
    kind: z.enum(["wall", "background", "object", "ground"]).optional(),
  })).max(MAX_SET_BLOCKS).optional(),
  setSource: z.enum(["moge-pointcloud", "background-estimate"]).optional(),
});

const commitBody = z.object({
  cacheKey: z.string().min(10).max(MAX_CACHE_KEY_CHARS),
  decisions: z.array(shotDecisionSchema).max(600).optional(),
  geometries: z.array(shotGeometrySchema).max(600).optional(),
  skips: z.array(z.object({shotIndex: z.number().int().min(0).max(10_000), reason: z.string().min(1).max(1200)})).max(600).optional(),
  scoreYaml: z.string().max(MAX_SCORE_CHARS),
  scoreHash: z.string().max(200),
  statuses: z.array(z.enum(["pending", "blockout", "refining", "spatial", "edited"])).max(600),
  timings: cacheTimings.optional(),
});

export async function referenceAnalysisRoutes(app: FastifyInstance, pool: Pool) {
  app.post("/api/v1/workspaces/:workspaceId/reference-analysis", async (request) => {
    const {workspaceId} = z.object({workspaceId: z.uuid()}).parse(request.params);
    await member(pool, request, workspaceId);
    const input = body.parse(request.body ?? {});
    const images: AiTextImage[] = [];
    if (input.frames?.length) {
      for (const frame of input.frames) images.push(decodeFrame(frame));
    } else if (input.videoId) {
      images.push(await youtubePoster(input.videoId));
    } else {
      throw new HttpError(400, "Add a reference clip or a YouTube link first.");
    }
    const settings = await aiTextSettings(pool, workspaceId);
    const provider = imageTextProvider(settings);
    if (!provider) {
      throw new HttpError(503, "Reference analysis needs an image-capable AI text provider. Sign in to ChatGPT in Settings first.");
    }
    // The scoring contract the studio's parser understands: small JSON, defaults applied client-side.
    const duration = input.durationSec;
    const cuts = (input.cuts ?? []).filter((cut) => cut > 0 && cut < (duration ?? Number.POSITIVE_INFINITY)).sort((left, right) => left - right);
    const prompt = [
      "You are a film previsualisation supervisor.",
      cuts.length
        ? `You see ${images.length} representative frame${images.length === 1 ? "" : "s"}, ${images.length === cuts.length + 1 ? "one from each detected shot" : `sampled across the ${cuts.length + 1} detected shots`}, of one reference video, in playback order.`
        : images.length > 1
          ? `You see ${images.length} evenly spaced frames from one reference video, in playback order.`
          : "You see a single poster frame from a reference video, so motion has to be inferred conservatively.",
      duration === undefined ? "The exact clip duration is unknown; choose a natural total duration between 8 and 20 seconds." : `The clip is ${duration.toFixed(2)} seconds long.`,
      input.aspectRatio === undefined ? "" : `Its aspect ratio is ${input.aspectRatio.toFixed(3)}.`,
      cuts.length
        ? `Hard cuts were detected at ${cuts.map((cut) => cut.toFixed(2)).join(", ")} seconds. Return exactly ${cuts.length + 1} shots in order, one per segment; the first shot starts at 0 and the last ends at the clip duration. Do not invent, shift or remove cut points; the editor enforces those boundaries.`
        : "",
      input.shotIndices?.length
        ? `The ${images.length} frame(s) come from detected shots ${input.shotIndices.map((index) => index + 1).join(", ")} (1-based) of ${cuts.length + 1}. Return one shots item per frame, in this order; each item describes that shot.`
        : "",
      input.note ? `Director's note: ${input.note}` : "",
      "Reconstruct the scene as a grey-block previsualisation for a deterministic 3D choreography engine:",
      "- Return ONLY one JSON object, no markdown.",
      "- Fields: title (string), premise (one sentence), duration (seconds), stage ({width, depth} in metres),",
      "  entities (1-4 people as {id,label,kind:\"character\",position:[x,y,z] with y=0 on the floor,rotation:degrees,height:metres,color:\"#rrggbb\"}),",
      "  shots (3-8 items {label,start,end,camera:{target:entity id or [x,y,z], maneuver:\"dolly\"|\"arc\"|\"orbit\"|\"cut\", distance, pitch, yaw, lens}} in seconds),",
      "  blocking (per-person movement {entity,start,end,position:[x,y,z],lookAt:entity id}, optional).",
      "Place people plausibly: their screen positions in the frames decide left/right stage positions; keep them within the stage.",
      "Shots must cover the whole duration without gaps; the first shot is usually the widest.",
      "Do not invent extra people, subtitles, props or story beats that the frames do not show.",
    ].filter(Boolean).join("\n");
    const result = await generateText(provider, {
      system: "You return compact, strictly valid JSON for a previsualisation engine.",
      prompt,
      images,
      maxTokens: 2200,
      json: true,
      workspaceId,
    }, {pool});
    const plan = parsePlan(result.text);
    if (!plan) throw new HttpError(502, "The AI answer was not a usable scene plan. Try again.");
    return {plan, provider: result.provider, model: result.model, frames: images.length};
  });

  /* --------------------------------------------------------------------------------------------
   * POST .../reference-analysis/scan
   * The clip is streamed to a temp file and hashed in the same pass; the cache
   * key exists before any decode, so an identical clip never starts FFmpeg.
   * ------------------------------------------------------------------------------------------ */
  app.post(`${base}/reference-analysis/scan`, async (request) => {
    const {workspaceId} = z.object({workspaceId: z.uuid()}).parse(request.params);
    await member(pool, request, workspaceId);
    const file = await request.file();
    if (!file) throw new HttpError(400, "Choose a reference clip first.");
    const filename = file.filename ?? "reference.mp4";
    if (!looksLikeVideo(file.mimetype || "", filename)) throw new HttpError(400, "The reference must be a video file.");
    const startedAt = Date.now();
    const hashStarted = Date.now();
    let upload;
    try {
      upload = await saveUploadToTemp(file.file, filename);
    } catch (error) {
      if (error instanceof PyramidAnalysisError) throw new HttpError(413, error.message);
      throw error;
    }
    const hashMs = Date.now() - hashStarted;
    try {
      const paramsField = multipartTextField(file.fields, "params");
      const params = paramsField ? parseAnalysisParams(paramsField) : DEFAULT_ANALYSIS_PARAMS;
      const cacheKey = analysisCacheKey(upload.sha256, params);
      const cached = await readAnalysisCache(pool, workspaceId, cacheKey);
      if (cached?.clip && cached.shots.length) {
        /* A full hit returns the stored score with no FFmpeg and no disk work beyond
           the upload hash. A partial hit whose proxies were cleaned re-derives only
           the missing artifacts and keeps the cached score/decisions/geometries. */
        const pending = analysisPending(cached);
        const artifactsPresent = !pending.geometry || (await presentAnalysisArtifacts(cached.clip.sha256, cached.params)) !== null;
        if (artifactsPresent) {
          const timings: AnalysisTimings = {hashMs, cutsMs: 0, keyframesMs: 0, decisionsMs: 0, geometryMs: 0, totalMs: Date.now() - startedAt};
          const cache: AnalysisCacheState = {hit: true, stage: analysisCacheStage(cached), storedAt: cached.updatedAt || undefined};
          const scan = scanFromStored(cached, timings, cache);
          if (scan) return scan;
        }
        const rebuilt = await runPyramid({sourcePath: upload.path, sha256: upload.sha256, bytes: upload.bytes, cacheKey, params});
        const timings: AnalysisTimings = {hashMs, cutsMs: rebuilt.timings.cutsMs, keyframesMs: rebuilt.timings.keyframesMs, decisionsMs: 0, geometryMs: 0, totalMs: Date.now() - startedAt};
        const merged = await upsertAnalysisCache(pool, workspaceId, cacheKey, {clip: rebuilt.clip, params, shots: rebuilt.shots, stages: {pyramid: true, cuts: true, keyframes: true}, timings});
        const scan = scanFromStored(merged, timings, {hit: false, stage: analysisCacheStage(merged), storedAt: merged.updatedAt || undefined});
        if (scan) return scan;
      }
      /* Miss: probe, one decode for both proxies and the cut scan, motion
         energies, deterministic keyframes, decision JPEGs, meta.json. */
      const built = await runPyramid({sourcePath: upload.path, sha256: upload.sha256, bytes: upload.bytes, cacheKey, params});
      const timings: AnalysisTimings = {hashMs, cutsMs: built.timings.cutsMs, keyframesMs: built.timings.keyframesMs, decisionsMs: 0, geometryMs: 0, totalMs: Date.now() - startedAt};
      const stored = await upsertAnalysisCache(pool, workspaceId, cacheKey, {
        clip: built.clip,
        params,
        shots: built.shots,
        ...(cached?.statuses?.length ? {} : {statuses: initialShotStatuses(built.shots.length)}),
        stages: {pyramid: true, cuts: true, keyframes: true},
        timings,
      });
      const scan = scanFromStored(stored, timings, {hit: false, stage: analysisCacheStage(stored)});
      if (!scan) throw new HttpError(500, "The analysed clip could not be stored.");
      return scan;
    } finally {
      await removeUploadedClip(upload.path);
    }
  });

  /* --------------------------------------------------------------------------------------------
   * POST .../reference-analysis/scan-frames
   * A captured YouTube embed: keyframe stills instead of a clip. A hit answers
   * from the cache without the capture payload; a miss stores the 640 stills on
   * disk and the cache row exactly like a clip scan.
   * ------------------------------------------------------------------------------------------ */
  app.post(`${base}/reference-analysis/scan-frames`, {bodyLimit: CAPTURE_BODY_LIMIT}, async (request) => {
    const {workspaceId} = z.object({workspaceId: z.uuid()}).parse(request.params);
    await member(pool, request, workspaceId);
    const parsed = parseFrameScanBody(request.body);
    return scanCapturedFrames({pool, workspaceId, request: parsed});
  });

  /* --------------------------------------------------------------------------------------------
   * POST .../reference-analysis/geometry
   * Route shell only: cached geometries are returned without a run, the missing
   * shots go to the one geometry module (proxy clip for files, stored 640 stills
   * for a capture), and the measured rows are cached.
   * ------------------------------------------------------------------------------------------ */
  app.post(`${base}/reference-analysis/geometry`, async (request): Promise<GeometryBatchResult> => {
    const {workspaceId} = z.object({workspaceId: z.uuid()}).parse(request.params);
    await member(pool, request, workspaceId);
    const input = geometryBody.parse(request.body ?? {});
    const cached = await readAnalysisCache(pool, workspaceId, input.cacheKey);
    if (!cached?.clip || !cached.shots.length) throw new HttpError(404, "This clip has not been scanned on the server yet.");
    for (const shotIndex of input.shotIndices) {
      if (shotIndex < 0 || shotIndex >= cached.shots.length) throw new HttpError(400, `Shot ${shotIndex} is outside the scanned clip.`);
    }
    const requested = [...new Set(input.shotIndices)].sort((left, right) => left - right);
    let measurement: Awaited<ReturnType<typeof measureCachedGeometry>>;
    try {
      measurement = await measureCachedGeometry({cacheKey: input.cacheKey, cached, requested, workspaceId});
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const message = error instanceof Error && error.message ? error.message : "";
      throw new HttpError(503, `The geometry worker could not measure these shots${message ? `: ${message}` : "."}`);
    }
    if (measurement.result.geometries.length) {
      await upsertAnalysisCache(pool, workspaceId, input.cacheKey, {geometries: measurement.result.geometries, timings: {geometryMs: measurement.result.timings.modelMs}});
    }
    return measurement.result;
  });

  /* --------------------------------------------------------------------------------------------
   * POST .../reference-analysis/cache
   * The studio commits its decisions/geometries/score; existing stages merge per
   * shot index, so an early commit never loses a later (or earlier) stage.
   * ------------------------------------------------------------------------------------------ */
  app.post(`${base}/reference-analysis/cache`, {bodyLimit: CACHE_COMMIT_BODY_LIMIT}, async (request) => {
    const {workspaceId} = z.object({workspaceId: z.uuid()}).parse(request.params);
    await member(pool, request, workspaceId);
    const commit = commitBody.parse(request.body ?? {});
    /* The server derives the stored score hash with the shared pure function, so
       "same score" is one comparison on both sides even if a client is stale. */
    const hash = commit.scoreYaml.trim() ? scoreHash(commit.scoreYaml) : "";
    const stored = await upsertAnalysisCache(pool, workspaceId, commit.cacheKey, {
      ...(commit.decisions?.length ? {decisions: commit.decisions as ShotDecision[]} : {}),
      ...(commit.geometries?.length ? {geometries: commit.geometries as ShotGeometry[]} : {}),
      ...(commit.skips?.length ? {skips: commit.skips as ShotSkip[]} : {}),
      ...(hash ? {scoreYaml: commit.scoreYaml, scoreHash: hash} : {}),
      ...(commit.statuses.length ? {statuses: commit.statuses} : {}),
      ...(commit.timings ? {timings: commit.timings} : {}),
    });
    const result: AnalysisCacheCommitResult = {
      cacheKey: commit.cacheKey,
      stored: true,
      scoreHash: stored.scoreHash,
      complete: stored.scoreYaml.trim().length > 0 && !analysisPending(stored).decisions && !analysisPending(stored).geometry,
    };
    return result;
  });
}

/** A frame from the browser arrives as `data:image/jpeg;base64,...`. */
function decodeFrame(frame: string): AiTextImage {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(frame);
  if (!match) throw new HttpError(400, "Frames must be jpeg, png or webp data URLs.");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_FRAME_BYTES) throw new HttpError(413, "A frame is empty or too large.");
  return {mediaType: match[1], bytes: new Uint8Array(bytes)};
}

/** YouTube exposes no frames to an embed; the poster is the one still the server can read. */
async function youtubePoster(videoId: string): Promise<AiTextImage> {
  for (const name of ["maxresdefault", "hqdefault", "mqdefault"]) {
    try {
      const response = await fetch(`https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/${name}.jpg`, {signal: AbortSignal.timeout(15_000), redirect: "error"});
      if (!response.ok) continue;
      const type = (response.headers.get("content-type") ?? "").split(";")[0];
      if (!type.startsWith("image/")) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_POSTER_BYTES) continue;
      return {mediaType: type, bytes};
    } catch {
      // Try the next poster size.
    }
  }
  throw new HttpError(502, "The YouTube poster could not be loaded.");
}

/** Model answers occasionally wrap JSON in prose or fences; take the first object that parses. */
export function parsePlan(text: string): Plan | null {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const candidates = [cleaned];
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Plan;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Next candidate.
    }
  }
  return null;
}

/* ------------------------------------------------------------------------------------------------
 * Helpers for the reproducible-analysis routes.
 * ---------------------------------------------------------------------------------------------- */

type Plan = {
  title?: string;
  premise?: string;
  duration?: number;
  stage?: {width?: number; depth?: number};
  entities?: Array<{id?: string; label?: string; kind?: string; position?: number[]; rotation?: number; height?: number; color?: string}>;
  shots?: Array<{label?: string; start?: number; end?: number; camera?: Record<string, unknown>}>;
  blocking?: Array<{entity?: string; start?: number; end?: number; position?: number[]; lookAt?: string}>;
};

function looksLikeVideo(mimetype: string, filename: string): boolean {
  return mimetype.startsWith("video/") || /\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(filename);
}

/** One text field of a multipart upload, whether the caller sends it once or repeatedly. */
function multipartTextField(fields: unknown, name: string): string | undefined {
  if (!fields || typeof fields !== "object") return undefined;
  const entry = (fields as Record<string, unknown>)[name];
  const value = Array.isArray(entry) ? (entry[0] as {value?: unknown} | undefined)?.value : (entry as {value?: unknown} | undefined)?.value;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The optional params JSON field of the scan; an unsupported contract version is refused. */
function parseAnalysisParams(value: string): AnalysisParams {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new HttpError(400, "The analysis params field is not valid JSON.");
  }
  const parsed = paramsSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "The analysis params are not valid.");
  if (parsed.data.version !== ANALYSIS_CONTRACT_VERSION) {
    throw new HttpError(409, `This server speaks analysis contract version ${ANALYSIS_CONTRACT_VERSION}.`);
  }
  return parsed.data as AnalysisParams;
}

/** Map the pyramid module's failures onto HTTP statuses: missing tool = 503, bad clip = 422. */
async function runPyramid(input: {sourcePath: string; sha256: string; bytes: number; cacheKey: string; params: AnalysisParams}) {
  try {
    return await buildAnalysisPyramid(input);
  } catch (error) {
    if (error instanceof PyramidToolUnavailableError) throw new HttpError(503, error.message);
    if (error instanceof PyramidAnalysisError) throw new HttpError(422, error.message);
    throw error;
  }
}

/** The AnalysisScan for a stored row, or null when the row has no usable clip/shots yet. */
function scanFromStored(stored: StoredAnalysis, timings: AnalysisTimings, cache: AnalysisCacheState): AnalysisScan | null {
  if (!stored.clip || !stored.shots.length) return null;
  const scoreYaml = stored.scoreYaml;
  return {
    contractVersion: ANALYSIS_CONTRACT_VERSION,
    cacheKey: stored.cacheKey,
    clip: stored.clip,
    params: stored.params ?? DEFAULT_ANALYSIS_PARAMS,
    shots: stored.shots,
    statuses: stored.statuses.length === stored.shots.length ? stored.statuses : initialShotStatuses(stored.shots.length),
    decisions: stored.decisions,
    geometries: stored.geometries,
    skips: stored.skips,
    scoreYaml,
    scoreHash: stored.scoreHash || scoreHash(scoreYaml),
    timings,
    cache,
    pending: analysisPending(stored),
  };
}

/* ------------------------------------------------------------------------------------------------
 *: YouTube tab capture. The cache token is `youtube:<videoId>` and the key
 * is videoId + capture params + model versions (no clip SHA is possible). The
 * 640 stills are written to disk so the geometry stage can read them back.
 * ---------------------------------------------------------------------------------------------- */

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function captureFailure(error: unknown): Error {
  if (error instanceof CaptureFrameError) return new HttpError(400, error.message);
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Strict cross-field validation for a captured scan: aligned 320 frames and 640
 * stills per keyframe, monotonic non-overlapping shots, keyframes inside their
 * shot, unique roles. The zod schema already bounds every single value.
 */
export function normalizeFrameScanRequest(body: AnalysisFrameScanRequest): AnalysisFrameScanRequest {
  const {capture, clip, shots} = body;
  if (!shots) return body;
  if (!shots.length) throw new HttpError(400, "A captured analysis needs at least one shot.");
  if (shots.length > MAX_CAPTURE_SHOTS) throw new HttpError(400, `A captured analysis is limited to ${MAX_CAPTURE_SHOTS} shots.`);
  const seen = new Set<number>();
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const [order, shot] of shots.entries()) {
    if (seen.has(shot.index)) throw new HttpError(400, "Every captured shot needs a unique index.");
    seen.add(shot.index);
    if (!(shot.endSec > shot.startSec)) throw new HttpError(400, "A captured shot must end after it starts.");
    if (shot.endSec > clip.durationSec + 0.5) throw new HttpError(400, "A captured shot lies outside the captured clip.");
    if (order > 0 && shot.startSec < previousEnd - 0.05) throw new HttpError(400, "Captured shots must not overlap and must be in playback order.");
    previousEnd = Math.max(previousEnd, shot.endSec);
    if (shot.keyframes.length > capture.keyframes) throw new HttpError(400, `At most ${capture.keyframes} keyframes per shot are captured.`);
    if (shot.frames.length !== shot.keyframes.length || shot.stills.length !== shot.keyframes.length) {
      throw new HttpError(400, "Every captured keyframe needs exactly one 320 px frame and one 640 px still.");
    }
    const roles = new Set<string>();
    for (const keyframe of shot.keyframes) {
      if (roles.has(keyframe.role)) throw new HttpError(400, "A captured shot may carry only one keyframe per role.");
      roles.add(keyframe.role);
      if (keyframe.timeSec < shot.startSec - 0.1 || keyframe.timeSec > shot.endSec + 0.1) throw new HttpError(400, "A captured keyframe lies outside its shot.");
    }
    for (let index = 0; index < shot.stills.length; index++) {
      const still = shot.stills[index];
      const keyframe = shot.keyframes[index];
      if (still.role !== keyframe.role || Math.abs(still.timeSec - keyframe.timeSec) > 0.05) {
        throw new HttpError(400, "The 640 stills must follow the same keyframes as the 320 frames.");
      }
      if (still.timeSec < shot.startSec - 0.1 || still.timeSec > shot.endSec + 0.1) throw new HttpError(400, "A captured still lies outside its shot.");
    }
  }
  return body;
}

/** Validate the route body; a contract version this server does not speak is a 409. */
export function parseFrameScanBody(body: unknown): AnalysisFrameScanRequest {
  const parsed = frameScanBody.parse(body ?? {});
  if (parsed.params && parsed.params.version !== ANALYSIS_CONTRACT_VERSION) {
    throw new HttpError(409, `This server speaks analysis contract version ${ANALYSIS_CONTRACT_VERSION}.`);
  }
  return normalizeFrameScanRequest(parsed as AnalysisFrameScanRequest);
}

/**
 * The captured scan: cache hit answers from the stored row (frames may be
 * omitted); a miss writes the 640 stills + manifest and stores the row exactly
 * like a clip scan, so the client decision/geometry loop runs unchanged.
 */
export async function scanCapturedFrames(input: {pool: Pool; workspaceId: string; request: AnalysisFrameScanRequest}): Promise<AnalysisScan> {
  const startedAt = Date.now();
  const request = input.request;
  const params = request.params ?? DEFAULT_ANALYSIS_PARAMS;
  const cacheKey = youtubeAnalysisCacheKey(request.videoId, request.capture, params);
  const cacheToken = youtubeClipToken(request.videoId);
  const cached = await readAnalysisCache(input.pool, input.workspaceId, cacheKey);
  if (cached?.clip && cached.shots.length) {
    // A hit never needs the capture again. If the client did send frames (e.g. a
    // re-capture), refresh the stills so a cleaned capture directory heals.
    if (request.shots?.length) {
      try {
        await saveCaptureStills({cacheToken, cacheKey, workspaceId: input.workspaceId, videoId: request.videoId, capture: request.capture, clip: request.clip, shots: request.shots});
      } catch (error) {
        throw captureFailure(error);
      }
    }
    const timings: AnalysisTimings = {hashMs: 0, cutsMs: 0, keyframesMs: 0, decisionsMs: 0, geometryMs: 0, totalMs: Date.now() - startedAt};
    const scan = scanFromStored(cached, timings, {hit: true, stage: analysisCacheStage(cached), storedAt: cached.updatedAt || undefined});
    if (!scan) throw new HttpError(500, "The cached capture could not be read.");
    return scan;
  }
  if (!request.shots?.length) throw new HttpError(400, "The first analysis of a captured video needs its keyframe stills.");
  const shotsInput = request.shots;
  let captured: Awaited<ReturnType<typeof saveCaptureStills>>;
  try {
    captured = await saveCaptureStills({cacheToken, cacheKey, workspaceId: input.workspaceId, videoId: request.videoId, capture: request.capture, clip: request.clip, shots: shotsInput});
  } catch (error) {
    throw captureFailure(error);
  }
  const shots: AnalysisShot[] = shotsInput.map((shot) => ({
    index: shot.index,
    startSec: round3(shot.startSec),
    endSec: round3(shot.endSec),
    keyframes: shot.keyframes.map((keyframe) => ({index: keyframe.index, timeSec: round3(keyframe.timeSec), role: keyframe.role})),
    frames: shot.frames,
  }));
  // Shot starts are the cut list for a capture: the client sampled the player clock.
  const cuts = shots.slice(1).map((shot) => round3(shot.startSec)).filter((cut) => cut > 0.2 && cut < request.clip.durationSec - 0.2);
  const clip: ClipFacts = {
    sha256: cacheToken,
    // No video file is stored; the captured still bytes are the honest size.
    bytes: captured.bytes,
    durationSec: round3(request.clip.durationSec),
    width: request.clip.width,
    height: request.clip.height,
    fps: round3(request.capture.fps),
    aspectRatio: round3(request.clip.aspectRatio),
    cuts,
    source: "youtube",
    videoId: request.videoId,
  };
  const timings: AnalysisTimings = {hashMs: 0, cutsMs: 0, keyframesMs: 0, decisionsMs: 0, geometryMs: 0, totalMs: Date.now() - startedAt};
  const stored = await upsertAnalysisCache(input.pool, input.workspaceId, cacheKey, {
    clip,
    params,
    shots,
    statuses: initialShotStatuses(shots.length),
    stages: {pyramid: true, cuts: true, keyframes: true},
    timings,
  });
  const scan = scanFromStored(stored, timings, {hit: false, stage: analysisCacheStage(stored)});
  if (!scan) throw new HttpError(500, "The captured analysis could not be stored.");
  return scan;
}

/* ------------------------------------------------------------------------------------------------
 * Geometry over a cached analysis: proxy clip for a file scan, stored 640 stills
 * for a capture. Exported with a runner seam so the whole dispatch is testable
 * without ComfyUI or a proxy clip.
 * ---------------------------------------------------------------------------------------------- */

export type GeometryRunner = typeof runGeometryBatch;
/** The runner input; geometry owns the optional `stills` field for captured shots. */
export type GeometryRunnerInput = Parameters<GeometryRunner>[0];

/**
 * Measure the requested shots that are not cached yet and merge the answers.
 * Captured rows use stills mode (no proxy): the stored 640 stills are the input
 * and a shot without stills is a per-shot error, never a batch failure.
 */
export async function measureCachedGeometry(input: {cacheKey: string; cached: StoredAnalysis; requested: number[]; workspaceId: string; runner?: GeometryRunner}): Promise<{result: GeometryBatchResult; measured: boolean; capture: boolean}> {
  const startedAt = Date.now();
  const cached = input.cached;
  const clip = cached.clip;
  if (!clip) throw new HttpError(404, "This clip has not been scanned on the server yet.");
  const capture = isYoutubeClipToken(clip.sha256);
  const known = new Map(cached.geometries.map((geometry) => [geometry.shotIndex, geometry]));
  const missing = input.requested.filter((shotIndex) => !known.has(shotIndex));
  if (!missing.length) {
    return {
      measured: false,
      capture,
      result: {
        cacheKey: input.cacheKey,
        geometries: input.requested.map((shotIndex) => known.get(shotIndex) as ShotGeometry),
        errors: [],
        timings: {batchMs: Date.now() - startedAt, modelMs: 0},
      },
    };
  }
  const params = cached.params ?? DEFAULT_ANALYSIS_PARAMS;
  const missingSet = new Set(missing);
  const shots = cached.shots.filter((shot) => missingSet.has(shot.index));
  const runner = input.runner ?? runGeometryBatch;
  const perShotErrors: Array<{shotIndex: number; message: string}> = [];
  let output: Awaited<ReturnType<GeometryRunner>>;
  if (capture) {
    const {dir, byShot} = await captureStillsByShot(clip.sha256, {workspaceId: input.workspaceId, cacheKey: input.cacheKey});
    const runShots: typeof shots = [];
    const stillsInput: NonNullable<GeometryRunnerInput["stills"]> = [];
    for (const shot of shots) {
      const stills = byShot.get(shot.index) ?? [];
      if (!stills.length) {
        perShotErrors.push({shotIndex: shot.index, message: CAPTURE_STILLS_MISSING});
        continue;
      }
      runShots.push(shot);
      stillsInput.push({shotIndex: shot.index, stills: stills.map((still) => ({timeSec: still.timeSec, role: still.role, path: still.path}))});
    }
    if (runShots.length) {
      output = await runner({cacheKey: input.cacheKey, clip, shots: runShots, artifacts: {geometryProxy: "", dir}, params, stills: stillsInput});
    } else {
      output = {geometries: [], errors: [], timings: {batchMs: Date.now() - startedAt, modelMs: 0}};
    }
  } else {
    const artifacts = await presentAnalysisArtifacts(clip.sha256, cached.params);
    if (!artifacts) throw new HttpError(409, "The cached clip proxies are missing on this server. Scan the clip again.");
    output = await runner({cacheKey: input.cacheKey, clip, shots, artifacts: {geometryProxy: artifacts.geometryProxy, dir: artifacts.dir}, params});
  }
  const errors = [...output.errors.filter((entry) => missingSet.has(entry.shotIndex)), ...perShotErrors];
  const finalGeometries = new Map(known);
  for (const geometry of output.geometries) finalGeometries.set(geometry.shotIndex, geometry);
  for (const shotIndex of missing) {
    if (finalGeometries.has(shotIndex) || errors.some((entry) => entry.shotIndex === shotIndex)) continue;
    errors.push({shotIndex, message: "The geometry worker returned no result for this shot."});
  }
  return {
    measured: true,
    capture,
    result: {
      cacheKey: input.cacheKey,
      geometries: input.requested.map((shotIndex) => finalGeometries.get(shotIndex)).filter((geometry): geometry is ShotGeometry => !!geometry),
      errors,
      timings: output.timings,
    },
  };
}

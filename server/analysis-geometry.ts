/*
 * The geometry stage: per shot, a wide keyframe still -> MoGe-2 metric mesh ->
 * plausible floor plane + camera height/pitch/FOV, and the shot's 640 px clip ->
 * SAM 3.1 person masks -> metric root positions on the floor plane.
 *
 * This is the only module the reference-analysis route imports. Two rules from
 * the user's bug report shape the batch:
 *
 * 1. Frame selection: a wide "start" keyframe is the first choice - the motion
 *    peak "middle" keyframe can be a blurry torso close-up with no floor. If the
 *    fitted floor fails the plausibility gate (floorPlausibility in
 *    src/film-studio/geometry.ts: up-normal within 25 deg of vertical, camera
 *    height 0.6..2.6 m, >= 40 inliers) the next keyframe candidate is tried, up
 *    to three, and every attempt is named in the evidence and in the error.
 * 2. No floor and no person (confirmed by SAM3 on the keyframes) means the shot is NOT
 *    measured: it stays a blockout shot and is returned as a per-shot error, never as a
 *    fabricated pitch/root position. The person pass runs BEFORE any MoGe work for the
 *    whole batch, so a shot without a person (e.g. a title card) never pays for a floor
 *    attempt, and a person-positive shot that d3's people_count called empty is still
 *    measured - the client's d3 hint is not the server's decision.
 * 3. A person-positive shot whose floor fails the gate is no longer skipped: it gets an
 *    ESTIMATED geometry (quality "estimated") from the person's apparent size - the
 *    person-height anchor (full body visible, 1.75 m) or the head-size anchor (head +
 *    shoulder line, 1.75/7.5 m) - plus the MoGe lens fit, a camera height borrowed from a
 *    measured neighbour shot (index +-3) or person eye level, and the mask-centre bearing.
 *    The fitted-but-rejected plane's tilt is kept only as a camera pitch estimate.
 *
 * Batches are submit-first, poll-later: all SAM3 person clips are submitted before the
 * first /history read, then (for person-positive shots) all MoGe prompts of one attempt
 * round. ComfyUI serialises the GPU work itself.
 *
 * Deliberate deviation from "unchanged official blueprints": the
 * official Geometry Estimation (MoGe) and Video Segmentation (SAM3) blueprints
 * are used as checked-in byte-identical copies, converted to API graphs by
 * src/workflow/ui-to-api.ts. The blueprints ship without any output nodes and
 * with their top-level subgraph inputs unwired, so the conversion completes the
 * graph the way the ComfyUI editor does (source loader wired into the instance,
 * widget proxies set) and appends only output-binding nodes: SaveGLB for the
 * mesh, MaskToImage -> SaveImage for the masks. The conversion test in
 * test/analysis-blueprints.test.ts proves the core graph is the blueprint's.
 */
import {execFile} from "node:child_process";
import {copyFile, mkdir, readFile, stat, writeFile} from "node:fs/promises";
import {dirname, isAbsolute, join} from "node:path";
import {promisify} from "node:util";
import sharp from "sharp";
import type {
  AnalysisParams,
  AnalysisShot,
  ClipFacts,
  GeometryCamera,
  GeometryFloor,
  PersonTrack,
  SceneBlock,
  GeometryQuality,
  KeyframeRole,
  ShotEstimate,
  ShotGeometry,
} from "../src/film-studio/analysis-contract";
import {lensMmFromHorizontalFov} from "../src/film-studio/analysis-contract";
import {
  cameraFromFloor,
  distanceFromAnchorSize,
  eyeLevelCameraHeightM,
  fitFloorPlane,
  fitFovFromUv,
  floorPlausibility,
  estimatedBackdropBlocks,
  measureCamera,
  PERSON_HEIGHT_ANCHOR_M,
  pitchedLevelFloor,
  rootFromAnchorBearing,
  sceneBasis,
  stagePointFromCamera,
  syntheticLevelFloor,
  toContractFloor,
  voxelizeSetBands,
  type CameraIntrinsics,
  type CameraMeasurement,
  type FloorPlane,
  type FovFit,
} from "../src/film-studio/geometry";
import {
  analyzePersons,
  assignMaskFrames,
  classifyMaskAnchor,
  DEFAULT_MIN_MASK_AREA_RATIO,
  readMaskProfile,
  readMaskStats,
  type MaskImage,
  type PersonAnalysis,
} from "./analysis-persons";
import {mogeGraph, sam3Graph} from "./analysis/graphs";
import {ComfyAnalysisClient, filesWithExtension, type ComfyPromptExecution} from "./comfy-analysis-runner";
import {gltfToCameraPositions, readGlbMesh} from "./glb-mesh";
import {extractKeyframeStill, ffmpegCommand, probeClip} from "./reference-pyramid";

const execFileAsync = promisify(execFile);

/** One shot the geometry stage must measure (a structural subset of AnalysisShot). */
export type ShotGeometryInput = Pick<AnalysisShot, "index" | "startSec" | "endSec" | "keyframes">;

export type GeometryBatchInput = {
  cacheKey: string;
  clip: ClipFacts;
  shots: ShotGeometryInput[];
  artifacts: {
    /** 640 px proxy clip: absolute, or relative to `dir`. */
    geometryProxy: string;
    /** The clip's analysis cache directory (absolute). */
    dir: string;
  };
  params: AnalysisParams;
  /** Test seam only: inject a ComfyUI client (production leaves this unset). */
  deps?: {client?: ComfyAnalysisClient};
  /**
   * Pre-saved 640 stills (YouTube tab capture / frame storage): when present no proxy is read,
   * the stills are used directly for the MoGe attempts and the person clip.
   */
  stills?: CaptureStillsInput[];
};

/** One pre-saved capture still for a shot (absolute path). */
export type CaptureStillInput = {timeSec: number; role: KeyframeRole; path: string};

/** All pre-saved stills of one shot (capture/frame-storage output). */
export type CaptureStillsInput = {shotIndex: number; stills: CaptureStillInput[]};

/**
 * Order capture stills the way the geometry stage prefers them: start, middle, end, motion,
 * then anything else in its given order (stable). Pure, for the capture route and its tests.
 */
export function orderedCaptureStills(stills: CaptureStillInput[]): CaptureStillInput[] {
  const priority: Record<string, number> = {start: 0, middle: 1, end: 2, motion: 3};
  return [...stills]
    .map((still, index) => ({still, index, rank: priority[still.role] ?? 4}))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.still);
}

export type GeometryBatchOutput = {
  geometries: ShotGeometry[];
  errors: Array<{shotIndex: number; message: string}>;
  timings: {batchMs: number; modelMs: number};
};

/** The role a still's time came from; "midpoint" when the shot has no keyframes. */
export type StillRole = KeyframeRole | "midpoint";

export type StillCandidate = {timeSec: number; role: StillRole};

/** One MoGe attempt on one candidate still, as recorded in the evidence. */
export type GeometryAttemptEvidence = {
  timeSec: number;
  role: StillRole;
  status: "accepted" | "rejected" | "model_failed" | "not_run";
  reasons: string[];
  floor?: GeometryFloor;
  tiltDeg?: number;
  vertices?: number;
  modelMs?: number;
};

export type GeometryEvidence = {
  persons: PersonAnalysis | null;
  stillWidth: number;
  stillHeight: number;
  attempts: GeometryAttemptEvidence[];
  acceptedStillTimeSec?: number;
  rawPersonHeightsM: number[];
  /** Absolute clip seconds of the keyframe stills the SAM3 person clip contains. */
  personFrameTimesSec: number[];
  /** How many person masks SAM3 produced on those keyframes (0 = confirmed no person). */
  sam3MaskCount?: number;
  /** Why the shot stayed a blockout, when it did. */
  skipReason?: string;
  /** Directory with the saved person-clip frames, masks and mask stats when a shot was rejected for "no person root". */
  personPassDiagnostics?: string;
  /** "measured" when absent (older evidence), "estimated" for the anchor-based fallback. */
  quality?: GeometryQuality;
  /** The anchor that produced an estimated geometry. */
  estimate?: ShotEstimate;
  /** True when the anchor was a tiny/thumbnail person: a rough placeholder, not a scene measurement. */
  roughPlaceholder?: boolean;
  /** Set-block count of the shot (for the acceptance evidence). */
  setBlockCount?: number;
  setSource?: "moge-pointcloud" | "background-estimate";
};

/** The keyframe-still person clip the SAM3 pass sees (: 3 frames, not the shot clip). */
export type PersonClip = {
  path: string;
  bytes: number;
  frameTimesSec: number[];
  frameCount: number;
  width: number;
  height: number;
  fps: number;
};

/** Where a shot's still candidates come from, in preference order. */
export type PreparedStill = StillCandidate & {
  path: string;
  width: number;
  height: number;
  file?: string;
};

type AttemptResult = {
  accepted: boolean;
  reasons: string[];
  floor?: FloorPlane;
  fov?: FovFit | null;
  camera?: CameraMeasurement;
  vertices?: number;
  modelMs?: number;
  /** The MoGe mesh in camera space, kept for the set-block voxelizer (no second GPU pass). */
  mesh?: {positions: Float32Array; uvs: Float32Array; hasUvs: boolean; width: number; height: number};
};

type Attempt = {
  candidate: PreparedStill;
  promptId?: string;
  execution?: ComfyPromptExecution;
  result?: AttemptResult;
};

type PreparedShot = {
  shot: ShotGeometryInput;
  candidates: PreparedStill[];
  attempts: Attempt[];
  accepted?: Attempt;
  /** The keyframe-still clip the SAM3 person pass sees (not the full shot clip). */
  personClip: PersonClip;
  personClipFile?: string;
  /** Mask PNGs downloaded during the person-first confirmation, reused by the analysis. */
  masks?: MaskImage[];
  /** What the upright-person camera read measured or why it declined (diagnostics only). */
  uprightEvidence?: Record<string, unknown>;
  sam3PromptId?: string;
  sam3Execution?: ComfyPromptExecution;
  persons?: PersonAnalysis;
  error?: string;
  /**
   * Set when SAM3 confirmed no usable person: the shot is an environment shot. It
   * still gets MoGe and a rebuilt set, but no figure; the text is the SAM3 confirmation.
   */
  environment?: string;
};

/** Fewer MoGe rounds for an environment shot: the set needs a mesh, the floor only refines the camera. */
const ENVIRONMENT_STILL_ATTEMPTS = 2;
/** A still whose mean channel deviation is below this is a blank/title card: nothing to rebuild. */
const BLANK_STILL_STDEV = 10;

/** True for a near-uniform still (black frame, fade, plain title card). */
async function stillLooksBlank(path: string): Promise<boolean> {
  try {
    const stats = await sharp(path).stats();
    const channels = stats.channels.slice(0, 3);
    return channels.reduce((total, channel) => total + channel.stdev, 0) / Math.max(1, channels.length) < BLANK_STILL_STDEV;
  } catch {
    return true;
  }
}

type RunResult = {geometry?: ShotGeometry; evidence?: GeometryEvidence; error?: string; runtimeMs: number};

const MAX_ERROR_LENGTH = 500;
/** A warm 8-shot batch is ~16 min on this worker (MoGe-2 fp32 inference dominates); the timeout must fit one batch. */
const BATCH_TIMEOUT_MS = 1_800_000;
const MAX_STILL_ATTEMPTS = 3;
/** Explicit frame rate of the keyframe-still person clip; frame times are carried separately. */
export const PERSON_PASS_FPS = 4;

/** A top-cut person mask at least this share of the frame is a close-up, not a thumbnail. */
export const CLOSE_UP_MASK_AREA_RATIO = 0.08;

const errorText = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
};

function proxyPath(input: GeometryBatchInput): string {
  return isAbsolute(input.artifacts.geometryProxy) ? input.artifacts.geometryProxy : join(input.artifacts.dir, input.artifacts.geometryProxy);
}

/**
 * The still candidates for one shot, in preference order: the wide start keyframe
 * first (a motion-peak "middle" keyframe is often a blurry close-up with no floor),
 * then middle, then end. Without usable keyframes the shot midpoint is the only
 * candidate. At most three attempts.
 */
export function stillCandidatesForShot(shot: ShotGeometryInput): StillCandidate[] {
  const byRole = new Map<KeyframeRole, number>();
  for (const keyframe of shot.keyframes) {
    if (!byRole.has(keyframe.role) && Number.isFinite(keyframe.timeSec)) byRole.set(keyframe.role, keyframe.timeSec);
  }
  const ordered: StillCandidate[] = [];
  for (const role of ["start", "middle", "end"] as const) {
    const timeSec = byRole.get(role);
    if (timeSec !== undefined) ordered.push({timeSec, role});
  }
  if (!ordered.length) ordered.push({timeSec: (shot.startSec + shot.endSec) / 2, role: "midpoint"});
  // A cut can put start/end on the same instant; one attempt per distinct time.
  const unique: StillCandidate[] = [];
  for (const candidate of ordered) {
    if (unique.some((existing) => Math.abs(existing.timeSec - candidate.timeSec) < 0.001)) continue;
    unique.push(candidate);
  }
  return unique.slice(0, MAX_STILL_ATTEMPTS);
}

/** The first still candidate: retained for callers that only need one time. */
export function stillTimeForShot(shot: ShotGeometryInput): number {
  return stillCandidatesForShot(shot)[0].timeSec;
}

/** The still times clamped to the shot's frame window (one per candidate, in clip order). */
export function clampedStillTimes(shot: ShotGeometryInput, clipFps: number): number[] {
  const stillLimit = Math.max(0.05, 1 / Math.max(1, clipFps));
  return stillCandidatesForShot(shot).map((candidate) => Math.max(shot.startSec, Math.min(shot.endSec - stillLimit, candidate.timeSec)));
}

/**
 * FFmpeg arguments for the person clip: the N keyframe stills as an image sequence
 * at an explicit frame rate. The frame count is pinned, so the clip has exactly one
 * frame per keyframe regardless of the stills' nominal timing.
 */
export function personClipArgs(stillPattern: string, frameCount: number, outPath: string, fps = PERSON_PASS_FPS): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-framerate", String(fps),
    "-start_number", "0",
    "-i", stillPattern,
    "-frames:v", String(frameCount),
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    outPath,
  ];
}

/**
 * Build the tiny keyframe-still clip for one shot's SAM3 pass.
 * The stills are the same files the MoGe keyframe attempts read (the start still is
 * the MoGe still), copied into the analysis stills folder as `shot-N-kf-i.jpg` and
 * encoded into `clips/shot-N-persons.mp4` at PERSON_PASS_FPS. `frameTimesSec` stays
 * authoritative for the mask -> clip-time mapping.
 */
export async function preparePersonClip(input: {
  shotIndex: number;
  stillPaths: string[];
  frameTimesSec: number[];
  dir: string;
  fps?: number;
}): Promise<PersonClip> {
  if (!input.stillPaths.length || input.stillPaths.length !== input.frameTimesSec.length) {
    throw new Error("A person clip needs one still per keyframe time");
  }
  const stillDir = join(input.dir, "stills");
  const clipDir = join(input.dir, "clips");
  await mkdir(stillDir, {recursive: true});
  await mkdir(clipDir, {recursive: true});
  for (let index = 0; index < input.stillPaths.length; index++) {
    await copyFile(input.stillPaths[index], join(stillDir, `shot-${input.shotIndex}-kf-${index}.jpg`));
  }
  const outPath = join(clipDir, `shot-${input.shotIndex}-persons.mp4`);
  await runFfmpeg(personClipArgs(join(stillDir, `shot-${input.shotIndex}-kf-%d.jpg`), input.stillPaths.length, outPath, input.fps ?? PERSON_PASS_FPS));
  const probe = await probeClip(outPath);
  return {
    path: outPath,
    bytes: (await stat(outPath)).size,
    frameTimesSec: input.frameTimesSec.map((timeSec) => round(timeSec, 3)),
    frameCount: input.stillPaths.length,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
  };
}

async function runFfmpeg(args: string[]): Promise<void> {
  try {
    await execFileAsync(ffmpegCommand(), args, {timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024});
  } catch (error) {
    const stderr = String((error as {stderr?: string | Buffer}).stderr ?? "").trim();
    throw new Error(`FFmpeg could not build the person clip${stderr ? `: ${stderr.split(/\r?\n/).pop()}` : ""}`);
  }
}

/** Run up to `limit` promise factories at a time (FFmpeg processes, uploads). */
async function runLimited<T>(factories: Array<() => Promise<T>>, limit = 4): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = new Array(factories.length);
  let next = 0;
  const workers = Array.from({length: Math.min(limit, factories.length)}, async () => {
    while (next < factories.length) {
      const index = next++;
      try {
        results[index] = {status: "fulfilled", value: await factories[index]()};
      } catch (error) {
        results[index] = {status: "rejected", reason: error};
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function attemptToEvidence(attempt: Attempt): GeometryAttemptEvidence {
  const result = attempt.result;
  const status: GeometryAttemptEvidence["status"] = !result
    ? "not_run"
    : result.accepted
      ? "accepted"
      : result.floor
        ? "rejected"
        : "model_failed";
  return {
    timeSec: round(attempt.candidate.timeSec, 3),
    role: attempt.candidate.role,
    status,
    reasons: result?.reasons ?? [],
    ...(result?.floor ? {floor: toContractFloor(result.floor), tiltDeg: round(floorPlausibility(result.floor).tiltDeg, 1)} : {}),
    ...(result?.vertices !== undefined ? {vertices: result.vertices} : {}),
    ...(result?.modelMs !== undefined ? {modelMs: result.modelMs} : {}),
  };
}

/** "start @0.000 s: 56.3 deg tilt, ..." - every attempted keyframe named. */
function describeAttempts(shot: PreparedShot): string {
  return shot.attempts
    .map((attempt) => {
      const label = `${attempt.candidate.role} @${round(attempt.candidate.timeSec, 3).toFixed(3)} s`;
      if (!attempt.result) return `${label} (not run)`;
      return `${label} (${attempt.result.reasons.length ? attempt.result.reasons.join(", ") : "rejected"})`;
    })
    .join("; ");
}

/**
 * Measure every requested shot. Never throws for a shot-level failure: the shot
 * is reported in `errors` and the rest of the batch continues.
 */
export async function runGeometryBatch(input: GeometryBatchInput): Promise<GeometryBatchOutput> {
  const started = Date.now();
  const errors: Array<{shotIndex: number; message: string}> = [];
  const geometries: ShotGeometry[] = [];
  const evidence: Array<{shotIndex: number; evidence: GeometryEvidence}> = [];
  const failAll = (message: string): GeometryBatchOutput => ({
    geometries,
    errors: [
      ...errors,
      ...input.shots
        .filter((shot) => !geometries.some((geometry) => geometry.shotIndex === shot.index) && !errors.some((entry) => entry.shotIndex === shot.index))
        .map((shot) => ({shotIndex: shot.index, message})),
    ],
    timings: {batchMs: Date.now() - started, modelMs: batchModelMs(prepared)},
  });
  const prepared: PreparedShot[] = [];
  try {
    // Capture stills bypass the proxy entirely: no FFmpeg decode/scale of the reference video.
    const proxy = input.stills ? "" : proxyPath(input);
    const client = input.deps?.client ?? new ComfyAnalysisClient();
    const missing = await client.missingNodes([
      "LoadImage", "LoadVideo", "LoadMoGeModel", "MoGeInference", "MoGePointMapToMesh", "SaveGLB",
      "SAM3_Detect", "CheckpointLoaderSimple", "GetVideoComponents", "MaskToImage", "SaveImage",
    ]);
    if (missing.length) return failAll(`ComfyUI is missing the analysis nodes: ${missing.join(", ")}`);

    // 1. Extract the candidate keyframe stills for every shot and encode the tiny
    //    keyframe-still clip the SAM3 person pass reads (: 3 frames, not the
    //    shot clip). The MoGe still is the start candidate, so nothing is decoded twice.
    const entries = await runLimited(
      input.shots.map((shot) => async (): Promise<PreparedShot> => {
        const candidates: PreparedStill[] = [];
        const capture = input.stills?.find((entry) => entry.shotIndex === shot.index);
        if (input.stills) {
          // Pre-saved capture stills: use them directly (no proxy decode), start/middle/end/motion.
          const ordered = orderedCaptureStills(capture?.stills ?? []).slice(0, MAX_STILL_ATTEMPTS);
          for (const still of ordered) {
            try {
              const meta = await sharp(still.path).metadata();
              candidates.push({
                timeSec: still.timeSec,
                role: still.role,
                path: still.path,
                width: meta.width ?? input.params.pyramid.geometryWidth,
                height: meta.height ?? Math.round(input.params.pyramid.geometryWidth / Math.max(0.01, input.clip.aspectRatio)),
              });
            } catch {
              // An unreadable capture still is skipped like an unextractable proxy frame.
            }
          }
        } else {
          const times = clampedStillTimes(shot, input.clip.fps);
          for (let index = 0; index < times.length; index++) {
            const candidate = stillCandidatesForShot(shot)[index];
            try {
              const still = await extractKeyframeStill({geometryProxy: proxy, timeSec: times[index], width: input.params.pyramid.geometryWidth});
              const meta = await sharp(still.path).metadata();
              candidates.push({
                timeSec: times[index],
                role: candidate.role,
                path: still.path,
                width: meta.width ?? input.params.pyramid.geometryWidth,
                height: meta.height ?? Math.round(input.params.pyramid.geometryWidth / Math.max(0.01, input.clip.aspectRatio)),
              });
            } catch {
              // A candidate that cannot be extracted is simply not attempted; the next one is.
            }
          }
        }
        const personClip = candidates.length
          ? await preparePersonClip({
              shotIndex: shot.index,
              stillPaths: candidates.map((candidate) => candidate.path),
              frameTimesSec: candidates.map((candidate) => candidate.timeSec),
              dir: input.artifacts.dir,
            })
          : null;
        const entry: PreparedShot = {
          shot,
          candidates,
          attempts: [],
          personClip: personClip ?? {path: "", bytes: 0, frameTimesSec: [], frameCount: 0, width: 0, height: 0, fps: PERSON_PASS_FPS},
        };
        if (!candidates.length) {
          entry.error = input.stills
            ? `stills missing; capture again`
            : `No keyframe still could be extracted for this shot; kept blockout`;
        }
        return entry;
      }),
      4,
    );
    entries.forEach((result, index) => {
      const shot = input.shots[index];
      if (result.status === "fulfilled") prepared.push(result.value);
      else errors.push({shotIndex: shot.index, message: `Frame extraction failed: ${errorText(result.reason)}`});
    });
    if (!prepared.length) return failAll("No shot could be prepared for the geometry batch");
    for (const entry of prepared) if (entry.error) errors.push({shotIndex: entry.shot.index, message: entry.error});

    // 2. Upload every candidate still and the person clip before submitting anything.
    const uploads = await runLimited(
      prepared
        .filter((entry) => !entry.error)
        .flatMap((entry) => [
          ...entry.candidates.map((candidate) => async () => {
            const token = sanitize(input.cacheKey).slice(0, 12);
            candidate.file = await client.upload(`cfgeom-${token}-s${entry.shot.index}-${candidate.role}.jpg`, await readFileBytes(candidate.path), "image/jpeg");
          }),
          async () => {
            const token = sanitize(input.cacheKey).slice(0, 12);
            entry.personClipFile = await client.upload(`cfgeom-${token}-s${entry.shot.index}-persons.mp4`, await readFileBytes(entry.personClip.path), "video/mp4");
          },
        ]),
      4,
    );
    void uploads;
    for (const entry of prepared) {
      if (entry.error) continue;
      if (!entry.personClipFile || entry.candidates.some((candidate) => !candidate.file)) {
        entry.error = `A still or person clip upload to ComfyUI failed; shot kept blockout`;
        errors.push({shotIndex: entry.shot.index, message: entry.error});
      }
    }

    // 3. Person first: submit every shot's keyframe person clip up front, poll once, and read
    //    the mask counts. SAM3 confirms (or denies) a person before any MoGe work, so a title
    //    card never pays for a floor attempt. This is the server-side confirmation of the d3
    //    people_count hint: a person-positive shot d3 called empty must still be measured.
    const personPositive: PreparedShot[] = [];
    const noPerson: Array<{entry: PreparedShot; reason: string}> = [];
    const sam3Submitted: Array<{entry: PreparedShot; promptId: string}> = [];
    for (const entry of prepared.filter((candidate) => !candidate.error)) {
      try {
        const prompt = sam3Graph({videoFile: entry.personClipFile!, savePrefix: `analysis/persons/s${entry.shot.index}`, modelName: input.params.models.persons, prompt: "person:4"});
        sam3Submitted.push({entry, promptId: await client.submit(prompt.graph)});
      } catch (error) {
        entry.error = `person pass could not run; skipped (SAM3 prompt was rejected: ${errorText(error)})`;
        errors.push({shotIndex: entry.shot.index, message: entry.error});
      }
    }
    if (sam3Submitted.length) {
      const readyAt = Date.now() - started;
      let waitError: string | undefined;
      try {
        await client.waitAll(sam3Submitted.map(({promptId}) => promptId), {timeoutMs: Math.max(60_000, BATCH_TIMEOUT_MS - readyAt)});
      } catch (error) {
        waitError = `Geometry batch interrupted: ${errorText(error)}`;
      }
      for (const {entry, promptId} of sam3Submitted) {
        const execution = (await client.history(promptId).catch(() => undefined)) ?? {promptId, status: "pending" as const, outputs: {}};
        entry.sam3Execution = execution;
        entry.sam3PromptId = promptId;
        if (execution.status !== "completed") {
          const detail = execution.message ?? waitError ?? execution.status;
          // SAM3_Detect in the unchanged blueprint raises IndexError when a frame has zero
          // detections instead of returning an empty mask batch (ComfyUI 0.37.0). That failure
          // IS the confirmation of an empty keyframe set - the title-card case - so it maps to
          // the same "no person" skip instead of a generic model failure.
          const emptyDetection = /index 0 is out of bounds|size 0\b/i.test(detail);
          if (emptyDetection) {
            noPerson.push({entry, reason: `no person masks on ${entry.personClip.frameCount} keyframes (SAM3 detected nothing)`});
            continue;
          }
          entry.error = `person pass failed; skipped (SAM3 run ${execution.status === "failed" ? "failed" : "did not finish"}: ${detail})`;
          errors.push({shotIndex: entry.shot.index, message: entry.error});
          continue;
        }
        const maskCount = execution.outputs["9002"]?.length ?? 0;
        if (maskCount === 0) {
          // The server does not see the d3 people_count: SAM3 itself confirms "no person".
          noPerson.push({entry, reason: `no person masks on ${entry.personClip.frameCount} keyframes`});
          continue;
        }
        // Fetch the masks once: the area/head pre-check below decides whether any of them can
        // ever localize a root, and the accepted shot reuses the same bytes for the analysis.
        try {
          const masks: MaskImage[] = [];
          for (const file of execution.outputs["9002"] ?? []) masks.push({filename: file.filename, bytes: await client.download(file)});
          entry.masks = masks;
          // A mask cut by the top edge still carries a person when it is large: that is a face or
          // torso close-up, which the estimate anchors on the head width. Only small top-cut
          // blobs (UI thumbnails, background scraps) are no person.
          const usable = (await Promise.all(masks.map((mask) => readMaskStats(mask.bytes)))).some((stats) => {
            const areaRatio = stats.count / (stats.width * stats.height);
            return areaRatio >= DEFAULT_MIN_MASK_AREA_RATIO && (stats.minY > 1 || areaRatio >= CLOSE_UP_MASK_AREA_RATIO);
          });
          if (!usable) {
            // UI thumbnails/background blobs: SAM3 saw something, but no mask can carry a person
            // root (all too small or cut by the top edge). Confirmed skip - no MoGe work.
            noPerson.push({entry, reason: `no usable person mask on ${entry.personClip.frameCount} keyframes (${maskCount} masks, all too small or cut by the top edge)`});
            continue;
          }
        } catch (error) {
          entry.error = `person pass could not read the SAM3 masks; skipped: ${errorText(error)}`;
          errors.push({shotIndex: entry.shot.index, message: entry.error});
          continue;
        }
        personPositive.push(entry);
      }
    }

    // 3b. A confirmed no-person shot is an environment shot: its place is rebuilt from
    //     MoGe like any other shot. Only a blank still (black frame, fade, plain title card) keeps
    //     the old skip, because there is no place to rebuild.
    const environmentShots: PreparedShot[] = [];
    for (const {entry, reason} of noPerson) {
      if (await stillLooksBlank(entry.candidates[0].path)) {
        entry.error = `skipped after SAM3 confirmation: ${reason}; the still is blank (title card or fade)`;
        errors.push({shotIndex: entry.shot.index, message: entry.error});
        continue;
      }
      entry.environment = `no person: ${reason}`;
      environmentShots.push(entry);
    }

    // 4. MoGe attempt rounds for person-positive and environment shots: submit a whole round up
    //    front, poll once, keep the first attempt whose floor survives the plausibility gate,
    //    retry the next candidate otherwise (environment shots stop after two rounds).
    const mogeShots = [...personPositive, ...environmentShots];
    const attemptLimit = (entry: PreparedShot): number => Math.min(entry.candidates.length, entry.environment ? ENVIRONMENT_STILL_ATTEMPTS : MAX_STILL_ATTEMPTS);
    let remaining = mogeShots.filter((entry) => !entry.error);
    for (let round = 0; round < MAX_STILL_ATTEMPTS && remaining.length; round++) {
      const roundEntries = remaining.filter((entry) => round < attemptLimit(entry));
      if (!roundEntries.length) break;
      const submitted: Array<{entry: PreparedShot; attempt: Attempt}> = [];
      for (const entry of roundEntries) {
        const attempt: Attempt = {candidate: entry.candidates[round]};
        entry.attempts.push(attempt);
        try {
          const prompt = mogeGraph({imageFile: attempt.candidate.file!, savePrefix: `analysis/geometry/s${entry.shot.index}-a${round}`, texture: false, modelName: input.params.models.geometry});
          attempt.promptId = await client.submit(prompt.graph);
          submitted.push({entry, attempt});
        } catch (error) {
          attempt.result = {accepted: false, reasons: [`MoGe prompt was rejected: ${errorText(error)}`]};
        }
      }
      if (submitted.length) {
        const readyAt = Date.now() - started;
        const timeoutMs = Math.max(60_000, BATCH_TIMEOUT_MS - readyAt);
        let waitError: string | undefined;
        try {
          await client.waitAll(submitted.map(({attempt}) => attempt.promptId!), {timeoutMs});
        } catch (error) {
          waitError = `Geometry batch interrupted: ${errorText(error)}`;
        }
        for (const {entry, attempt} of submitted) {
          attempt.execution = (await client.history(attempt.promptId!).catch(() => undefined)) ?? {promptId: attempt.promptId!, status: "pending", outputs: {}};
          attempt.result = await evaluateMogeAttempt(client, entry, attempt, waitError);
          if (attempt.result.accepted) entry.accepted = attempt;
        }
      }
      // A plane tilted far from vertical can never become the floor on another still: stop
      // burning MoGe rounds and let the estimated (anchor-based) path take over.
      remaining = mogeShots.filter((entry) => !entry.error && !entry.accepted && !clearlyNotFloor(entry));
    }
    // 5a. Measured shots first: they are the neighbour-floor camera-height source for estimates.
    //     A person-positive shot whose roots cannot be placed on the measured floor falls through
    //     to the estimate (5b) and then to the environment rebuild (5c) instead of keeping nothing.
    const unplaced = new Map<number, string>();
    for (const entry of prepared) {
      if (entry.error || !entry.accepted) continue;
      const run = await analyzeAcceptedShot(client, entry, input.params, input.artifacts.dir);
      if (run.geometry) {
        geometries.push(run.geometry);
        if (run.evidence) evidence.push({shotIndex: entry.shot.index, evidence: run.evidence});
      } else if (run.error) {
        unplaced.set(entry.shot.index, run.error);
      }
    }
    const measuredGeometries = geometries.filter((geometry) => geometry.quality !== "estimated");
    const pushRun = (entry: PreparedShot, run: RunResult, fallbackError: string) => {
      if (run.geometry) geometries.push(run.geometry);
      else errors.push({shotIndex: entry.shot.index, message: run.error ?? fallbackError});
      if (run.evidence) evidence.push({shotIndex: entry.shot.index, evidence: run.evidence});
    };
    // 5b. Estimated shots: no usable floor, but a person-size anchor plus the MoGe FOV still
    //     place the camera and the person. Marked quality "estimated", never silently skipped.
    for (const entry of personPositive) {
      if (entry.error || geometries.some((geometry) => geometry.shotIndex === entry.shot.index)) continue;
      const estimated = await buildEstimatedShot(entry, input.params, measuredGeometries, input.artifacts.dir);
      if (estimated.geometry) {
        pushRun(entry, estimated, "");
        continue;
      }
      // 5c. No person could be placed: still rebuild the place, without a figure.
      const note = unplaced.get(entry.shot.index) ?? estimated.error ?? "no person could be placed";
      pushRun(entry, await buildEnvironmentShot(entry, input.params, measuredGeometries, note), note);
    }
    // 5d. Environment shots (SAM3 confirmed no person) without an accepted floor: camera and set
    //     from the MoGe mesh. An accepted one was measured in 5a.
    for (const entry of environmentShots) {
      if (entry.error || geometries.some((geometry) => geometry.shotIndex === entry.shot.index)) continue;
      const note = unplaced.get(entry.shot.index) ?? entry.environment!;
      pushRun(entry, await buildEnvironmentShot(entry, input.params, measuredGeometries, note), `skipped after SAM3 confirmation: ${note}`);
    }

    // Evidence for shots that never got a usable still/floor, so every attempt stays auditable.
    for (const entry of prepared) {
      if (evidence.some((item) => item.shotIndex === entry.shot.index)) continue;
      evidence.push({
        shotIndex: entry.shot.index,
        evidence: {
          persons: null,
          stillWidth: entry.candidates[0]?.width ?? 0,
          stillHeight: entry.candidates[0]?.height ?? 0,
          attempts: entry.attempts.map(attemptToEvidence),
          ...(entry.accepted ? {acceptedStillTimeSec: round(entry.accepted.candidate.timeSec, 3)} : {}),
          rawPersonHeightsM: [],
          personFrameTimesSec: [...entry.personClip.frameTimesSec],
          sam3MaskCount: entry.sam3Execution?.outputs["9002"]?.length ?? 0,
          ...(entry.error ? {skipReason: entry.error} : {}),
        },
      });
    }
    const batchMs = Date.now() - started;
    geometries.sort((a, b) => a.shotIndex - b.shotIndex);
    lastGeometryEvidence.set(input.cacheKey, evidence);
    return {geometries, errors: dedupeErrors(errors), timings: {batchMs, modelMs: batchModelMs(prepared)}};
  } catch (error) {
    return failAll(`Geometry batch failed: ${errorText(error)}`);
  }
}

/** Per-cache evidence for the verification script / route diagnostics (not part of the contract). */
export const lastGeometryEvidence = new Map<string, Array<{shotIndex: number; evidence: GeometryEvidence}>>();

/** Read one MoGe attempt's GLB, fit the floor, apply the plausibility gate, fit the lens. */
async function evaluateMogeAttempt(client: ComfyAnalysisClient, _entry: PreparedShot, attempt: Attempt, waitError?: string): Promise<AttemptResult> {
  const execution = attempt.execution;
  const modelMs = execution?.durationMs;
  if (!execution || execution.status !== "completed") {
    const state = execution?.status === "failed" ? "failed" : "did not finish";
    return {accepted: false, reasons: [`MoGe run ${state}${execution?.message ? `: ${execution.message}` : waitError ? `: ${waitError}` : ""}`], modelMs};
  }
  const glbFile = filesWithExtension(execution.outputs["9000"] ?? [], "glb")[0];
  if (!glbFile) return {accepted: false, reasons: ["MoGe run produced no GLB mesh"], modelMs};
  let vertices: number | undefined;
  try {
    const mesh = readGlbMesh(new Uint8Array(await client.download(glbFile)));
    vertices = mesh.vertexCount;
    if (!mesh.vertexCount) return {accepted: false, reasons: ["MoGe mesh is empty"], vertices, modelMs};
    const cameraPositions = gltfToCameraPositions(mesh.positions);
    // The lens fit only needs the mesh, not the floor: the estimated (no-floor) geometry
    // needs it too, so it is computed before the floor gate can reject the shot.
    const fov = mesh.hasUvs ? fitFovFromUv(cameraPositions, mesh.uvs, attempt.candidate.width, attempt.candidate.height) : null;
    // Keep the mesh (no second GPU pass) so the measured shot can voxelize it into set blocks.
    const meshData = {positions: cameraPositions, uvs: mesh.uvs, hasUvs: mesh.hasUvs, width: attempt.candidate.width, height: attempt.candidate.height};
    const floor = fitFloorPlane(cameraPositions);
    if (!floor) return {accepted: false, reasons: [`no floor plane found in ${mesh.vertexCount} vertices`], fov, vertices, modelMs, mesh: meshData};
    const gate = floorPlausibility(floor);
    if (!gate.ok) {
      return {
        accepted: false,
        reasons: gate.reasons,
        floor,
        fov,
        vertices,
        modelMs,
        mesh: meshData,
      };
    }
    return {accepted: true, reasons: [], floor, fov, camera: measureCamera(floor, fov), vertices, modelMs, mesh: meshData};
  } catch (error) {
    return {accepted: false, reasons: [`MoGe mesh could not be read: ${errorText(error)}`], vertices, modelMs};
  }
}

/** A gate-failed plane tilted far from vertical cannot become a floor on another still. */
function clearlyNotFloor(entry: PreparedShot): boolean {
  return entry.attempts.some((attempt) => attempt.result?.floor && floorPlausibility(attempt.result.floor).tiltDeg > 45);
}

/** One person-size anchor found on one keyframe mask, with the mask geometry needed to use it. */
type KeyframeAnchor = {
  basis: "person-height" | "head-size";
  anchorM: number;
  anchorPx: number;
  centroidPx: number;
  maskWidth: number;
  maskHeight: number;
  timeSec: number;
  frameIndex: number;
};

/**
 * Estimated geometry for a person-positive shot with no usable floor (close-up / inset):
 * the subject distance comes from the person's apparent size (full person = 1.75 m, or the
 * head = 1.75/7.5 m) and the MoGe lens fit; the camera height comes from a measured
 * neighbour shot or from person eye level; the root comes from the mask-centre bearing.
 * The result is marked quality "estimated" with the anchor recorded in estimate.
 */
async function buildEstimatedShot(
  entry: PreparedShot,
  params: AnalysisParams,
  measuredGeometries: ShotGeometry[],
  artifactsDir: string,
): Promise<RunResult> {
  const attemptsEvidence = entry.attempts.map(attemptToEvidence);
  const attemptModelMs = entry.attempts.reduce((sum, attempt) => sum + (attempt.result?.modelMs ?? 0), 0);
  const sam3ModelMs = entry.sam3Execution?.durationMs ?? 0;
  const runtimeMs = attemptModelMs + sam3ModelMs;
  const diagnosticsDir = join(artifactsDir, "diagnostics", `shot-${entry.shot.index}`);
  const frameTimesSec = entry.personClip.frameTimesSec;
  const baseEvidence: GeometryEvidence = {
    persons: null,
    stillWidth: entry.candidates[0]?.width ?? 0,
    stillHeight: entry.candidates[0]?.height ?? 0,
    attempts: attemptsEvidence,
    rawPersonHeightsM: [],
    personFrameTimesSec: [...frameTimesSec],
    sam3MaskCount: entry.sam3Execution?.outputs["9002"]?.length ?? 0,
  };
  const fail = async (reason: string, anchors: KeyframeAnchor[] = []): Promise<RunResult> => {
    baseEvidence.skipReason = reason;
    const bundle = await writeEstimatedDiagnostics({dir: diagnosticsDir, entry, reason, anchors, estimate: null, geometry: null}).catch(() => undefined);
    if (bundle) baseEvidence.personPassDiagnostics = bundle;
    return {error: reason, evidence: baseEvidence, runtimeMs};
  };
  const masks = entry.masks ?? [];
  if (!masks.length) return fail(`no usable floor and no person masks on the keyframes (kept blockout); tried ${describeAttempts(entry)}`);
  // The lens fit is needed for every anchor: the first MoGe attempt whose UV <-> mesh fit is valid.
  const fovAttempt = entry.attempts.find((attempt) => attempt.result?.fov);
  const fov = fovAttempt?.result?.fov ?? null;
  if (!fov || !fovAttempt) return fail(`no usable floor and no MoGe lens fit for the estimated distance (kept blockout); tried ${describeAttempts(entry)}`, []);
  const {frames} = assignMaskFrames(masks.length, frameTimesSec.length);
  const frameTime = (frameIndex: number): number => frameTimesSec[Math.min(frameIndex, Math.max(0, frameTimesSec.length - 1))];
  // EVERY usable mask becomes a person observation with its own anchor/distance/root; the
  // tracks are associated across the sparse keyframes below (multi-person close-ups).
  type Observation = {
    frameIndex: number;
    timeSec: number;
    xM: number;
    zM: number;
    distanceM: number;
    basis: "person-height" | "head-size";
    anchorM: number;
    anchorPx: number;
    maskHeight: number;
    placeholder: boolean;
  };
  const observations: Observation[] = [];
  const anchors: KeyframeAnchor[] = [];
  // SAM3 can return the same silhouette two or three times in one keyframe; each copy would become
  // its own person. A mask that mostly overlaps one already kept for that keyframe is the same body.
  const keptByFrame = new Map<number, Array<{width: number; height: number; data: Uint8Array}>>();
  for (let index = 0; index < masks.length; index++) {
    const bitmap = await maskBitmap(masks[index].bytes).catch(() => undefined);
    if (bitmap) {
      const kept = keptByFrame.get(frames[index]) ?? [];
      if (kept.some((other) => maskOverlap(bitmap, other) > 0.6)) continue;
      kept.push(bitmap);
      keptByFrame.set(frames[index], kept);
    }
    let profile;
    try {
      profile = await readMaskProfile(masks[index].bytes);
    } catch {
      continue;
    }
    if (profile.count / (profile.width * profile.height) < DEFAULT_MIN_MASK_AREA_RATIO) continue;
    const anchor = classifyMaskAnchor(profile);
    if (!anchor) continue;
    const fxMask = fov.fxPx * (profile.width / fovAttempt.candidate.width);
    const distanceM = distanceFromAnchorSize(fxMask, anchor.anchorM, anchor.anchorPx);
    if (distanceM === null) continue;
    const root = rootFromAnchorBearing({fxPx: fxMask, centroidPx: anchor.centroidPx, imageWidth: profile.width, distanceM});
    if (!root) continue;
    const frameIndex = frames[index];
    const timeSec = frameTime(frameIndex);
    const placeholder = anchor.anchorPx < Math.max(20, profile.height * 0.06);
    observations.push({
      frameIndex,
      timeSec,
      xM: root.xM,
      zM: root.zM,
      distanceM,
      basis: anchor.basis,
      anchorM: anchor.anchorM,
      anchorPx: anchor.anchorPx,
      maskHeight: profile.height,
      placeholder,
    });
    anchors.push({basis: anchor.basis, anchorM: anchor.anchorM, anchorPx: anchor.anchorPx, centroidPx: anchor.centroidPx, maskWidth: profile.width, maskHeight: profile.height, timeSec, frameIndex});
  }
  if (!observations.length) {
    return fail(`no usable floor and no person-size anchor on the ${frameTimesSec.length} keyframes (kept blockout; every mask is too small or cut by the top edge); tried ${describeAttempts(entry)}`, []);
  }
  // Associate every mask observation with a person track: time-aware nearest in the floor frame.
  type TrackState = {observations: Observation[]; lastFrame: number; lastTimeSec: number; lastX: number; lastZ: number};
  const trackStates: TrackState[] = [];
  const ordered = [...observations].sort((left, right) => left.frameIndex - right.frameIndex || left.xM - right.xM);
  for (const observation of ordered) {
    let best: TrackState | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const state of trackStates) {
      if (state.lastFrame === observation.frameIndex) continue;
      const timeGap = observation.timeSec - state.lastTimeSec;
      const allowed = Math.min(6, Math.max(1.5, 3 * Math.max(0, timeGap)));
      const distance = Math.hypot(observation.xM - state.lastX, observation.zM - state.lastZ);
      if (distance < allowed && distance < bestDistance) {
        best = state;
        bestDistance = distance;
      }
    }
    if (best) {
      best.observations.push(observation);
      best.lastFrame = observation.frameIndex;
      best.lastTimeSec = observation.timeSec;
      best.lastX = observation.xM;
      best.lastZ = observation.zM;
    } else {
      trackStates.push({observations: [observation], lastFrame: observation.frameIndex, lastTimeSec: observation.timeSec, lastX: observation.xM, lastZ: observation.zM});
    }
  }
  const clusters = trackStates.sort((left, right) => right.observations.length - left.observations.length || left.observations[0].timeSec - right.observations[0].timeSec);
  // The closest/largest person anchor defines the camera estimate; every cluster keeps its roots.
  const primary = [...observations].sort((left, right) => right.anchorPx - left.anchorPx || left.timeSec - right.timeSec)[0];
  // A gate-failed plane is only a usable pitch estimate while it is near vertical; a close-up's
  // clothing/panel plane (tilt 45-80 deg) is not a camera tilt, so use 0 deg there.
  const floorAttempt = entry.attempts.find((attempt) => attempt.result?.floor);
  const floorTiltDeg = floorAttempt?.result?.floor ? floorPlausibility(floorAttempt.result.floor).tiltDeg : Number.POSITIVE_INFINITY;
  const planePitchDeg = floorAttempt?.result?.floor && floorTiltDeg <= 30 ? cameraFromFloor({...floorAttempt.result.floor, confidence: 0}).pitchDeg : 0;
  // The upright person is the better level: its axis gives the real tilt (a low angle looks up)
  // and, with feet or head in frame, the camera height.
  const uprightAttempt = fovAttempt.result?.mesh ? fovAttempt : setAttempt(entry);
  const upright = uprightAttempt
    ? await personUprightCamera(entry, uprightAttempt, PERSON_HEIGHT_ANCHOR_M, (outcome) => { entry.uprightEvidence = outcome; }).catch(() => null)
    : null;
  const pitchDeg = upright ? upright.pitchDeg : planePitchDeg;
  // Camera height: borrow a measured neighbour shot's floor height (index within +-3), else eye level.
  const neighbor = measuredGeometries
    .filter((geometry) => Math.abs(geometry.shotIndex - entry.shot.index) <= 3)
    .sort((left, right) => Math.abs(left.shotIndex - entry.shot.index) - Math.abs(right.shotIndex - entry.shot.index))[0];
  // A tiny or inconsistent anchor (gallery/UI thumbnails) is only a rough placeholder, not a scene measurement.
  const anchorPxValues = observations.map((observation) => observation.anchorPx);
  const anchorSpread = anchorPxValues.length > 1 ? Math.max(...anchorPxValues) / Math.max(1, Math.min(...anchorPxValues)) : 1;
  const roughPlaceholder = primary.placeholder || anchorSpread > 2.5;
  const personHeight = upright?.heightM !== undefined && (upright.basis === "person-feet" || upright.basis === "person-head") ? upright : null;
  const cameraHeightM = personHeight ? personHeight.heightM! : neighbor ? neighbor.camera.heightM : eyeLevelCameraHeightM(PERSON_HEIGHT_ANCHOR_M);
  const cameraHeightSource: ShotEstimate["cameraHeightSource"] = personHeight ? (personHeight.basis as "person-feet" | "person-head") : neighbor ? "neighbor-floor" : "eye-level";
  const estimate: ShotEstimate = {
    basis: primary.basis,
    anchorM: round(primary.anchorM, 4),
    anchorPx: round(primary.anchorPx, 3),
    subjectDistanceM: round(primary.distanceM, 3),
    cameraHeightSource,
    ...(neighbor && !personHeight ? {neighborShotIndex: neighbor.shotIndex} : {}),
    keyframeTimeSec: round(primary.timeSec, 3),
  };
  const persons: PersonTrack[] = clusters.map((cluster, index) => ({
    id: `person-${index + 1}`,
    heightM: PERSON_HEIGHT_ANCHOR_M,
    keyframes: [...cluster.observations]
      .sort((left, right) => left.timeSec - right.timeSec)
      .map((observation) => ({timeSec: round(observation.timeSec, 3), xM: round(observation.xM, 3), zM: round(observation.zM, 3), confidence: roughPlaceholder ? 0.2 : 0.4})),
  }));
  // The set from the MoGe mesh for a camera at the estimated height and pitch; the
  // flat backdrop wall behind the farthest person stays only as the fallback for an empty mesh.
  const meshAttempt = fovAttempt.result?.mesh ? fovAttempt : setAttempt(entry);
  const meshSet = meshAttempt
    ? await buildPointcloudSet({entry, attempt: meshAttempt, floor: pitchedLevelFloor(cameraHeightM, pitchDeg), persons}).catch(() => ({set: [] as SceneBlock[], setSource: "moge-pointcloud" as const}))
    : {set: [] as SceneBlock[], setSource: "moge-pointcloud" as const};
  const farthestDistanceM = Math.max(...observations.map((observation) => observation.distanceM));
  const set = meshSet.set.length
    ? meshSet.set
    : estimatedBackdropBlocks({
        subjectDistanceM: Math.max(primary.distanceM, farthestDistanceM),
        horizontalFovDeg: fov.horizontalFovDeg,
        cameraHeightM,
        personRoots: observations.map((observation) => ({xM: observation.xM, zM: observation.zM})),
      });
  const setSource = meshSet.set.length ? meshSet.setSource : ("background-estimate" as const);
  const keyframeSeconds = [...new Set(observations.map((observation) => round(observation.timeSec, 3)))].sort((left, right) => left - right);
  const geometry: ShotGeometry = {
    shotIndex: entry.shot.index,
    floor: toContractFloor(syntheticLevelFloor(cameraHeightM)),
    camera: {
      heightM: round(cameraHeightM, 3),
      pitchDeg: round(pitchDeg, 2),
      yawDeg: 0,
      fovDeg: round(fov.horizontalFovDeg, 2),
      lensMm: round(lensMmFromHorizontalFov(fov.horizontalFovDeg), 1),
      confidence: 0.25,
    },
    persons,
    set,
    setSource,
    source: {
      model: `${params.models.geometry} / ${params.models.persons}`,
      keyframeSeconds,
      runtimeMs,
    },
    quality: "estimated",
    estimate,
  };
  baseEvidence.quality = "estimated";
  baseEvidence.estimate = estimate;
  baseEvidence.roughPlaceholder = roughPlaceholder;
  baseEvidence.setBlockCount = set.length;
  baseEvidence.setSource = setSource;
  const bundle = await writeEstimatedDiagnostics({dir: diagnosticsDir, entry, reason: "estimated geometry (no usable floor)", anchors, estimate, geometry}).catch(() => undefined);
  if (bundle) baseEvidence.personPassDiagnostics = bundle;
  return {geometry, evidence: baseEvidence, runtimeMs};
}

/** Save the inputs and the decision of an estimated (or un-estimatable) shot for the acceptance audit. */
async function writeEstimatedDiagnostics(input: {
  dir: string;
  entry: PreparedShot;
  reason: string;
  anchors: KeyframeAnchor[];
  estimate: ShotEstimate | null;
  geometry: ShotGeometry | null;
  roughPlaceholder?: boolean;
}): Promise<string> {
  await mkdir(input.dir, {recursive: true});
  const artifactsDir = dirname(dirname(input.entry.personClip.path));
  const frameFiles: string[] = [];
  for (let index = 0; index < input.entry.personClip.frameTimesSec.length; index++) {
    const source = join(artifactsDir, "stills", `shot-${input.entry.shot.index}-kf-${index}.jpg`);
    const name = `frame-${index}-${round(input.entry.personClip.frameTimesSec[index], 3).toFixed(3)}s.jpg`;
    try {
      await copyFile(source, join(input.dir, name));
      frameFiles.push(name);
    } catch {
      // The frame bundle is best effort; the estimate JSON below still records the decision.
    }
  }
  const maskFiles: string[] = [];
  for (let index = 0; index < (input.entry.masks ?? []).length; index++) {
    const name = `mask-${String(index).padStart(2, "0")}.png`;
    await writeFile(join(input.dir, name), (input.entry.masks ?? [])[index].bytes);
    maskFiles.push(name);
  }
  const payload = {
    shotIndex: input.entry.shot.index,
    reason: input.reason,
    quality: input.estimate ? "estimated" : null,
    roughPlaceholder: input.roughPlaceholder ?? false,
    personFrameTimesSec: input.entry.personClip.frameTimesSec,
    frames: frameFiles,
    masks: maskFiles,
    anchors: input.anchors.map((anchor) => ({basis: anchor.basis, anchorM: anchor.anchorM, anchorPx: anchor.anchorPx, timeSec: anchor.timeSec, frameIndex: anchor.frameIndex, maskWidth: anchor.maskWidth, maskHeight: anchor.maskHeight})),
    attempts: input.entry.attempts.map(attemptToEvidence),
    upright: input.entry.uprightEvidence ?? null,
    estimate: input.estimate,
    geometry: input.geometry
      ? {floor: input.geometry.floor, camera: input.geometry.camera, persons: input.geometry.persons, set: input.geometry.set, setSource: input.geometry.setSource, quality: input.geometry.quality}
      : null,
  };
  const path = join(input.dir, "estimate.json");
  await writeFile(path, JSON.stringify(payload, null, 2));
  return path;
}

/** Decode a mask PNG into a 0/1 bitmap for mesh-point exclusion (the stills and masks share the frame). */
async function maskBitmap(bytes: Buffer): Promise<{width: number; height: number; data: Uint8Array}> {
  const {data, info} = await sharp(bytes, {failOn: "warning"}).greyscale().raw().toBuffer({resolveWithObject: true});
  return {width: info.width, height: info.height, data: new Uint8Array(data)};
}

/**
 * Every mask whose person clip frame matches one keyframe still time (within half a frame time).
 * SAM3 returns one mask per person per frame, so a frame with two people has two masks; all of
 * them are cut from the mesh, or the second person is voxelized into set blocks.
 */
function maskIndicesForStillTime(entry: PreparedShot, stillTimeSec: number): number[] {
  const masks = entry.masks ?? [];
  if (!masks.length || !entry.personClip.frameTimesSec.length) return [];
  const {frames} = assignMaskFrames(masks.length, entry.personClip.frameTimesSec.length);
  const deltas = masks.map((_, index) => Math.abs(entry.personClip.frameTimesSec[Math.min(frames[index], entry.personClip.frameTimesSec.length - 1)] - stillTimeSec));
  const best = Math.min(...deltas);
  if (best > 0.12) return [];
  return deltas.flatMap((delta, index) => (delta <= best + 1e-6 ? [index] : []));
}

/**
 * Camera pitch and height for a shot without a usable floor, read from the person instead (a
 * standing person is vertical in the world): the main axis of the largest person's MoGe points is
 * world "up" in camera space, so its tilt is the camera pitch - a low angle reads as looking up.
 * The height comes from the lowest person point when the feet are inside the frame, else from the
 * head top at the anchor height. Null when the person is too small or not clearly elongated.
 */
export async function personUprightCamera(
  entry: PreparedShot,
  attempt: Attempt,
  personHeightM: number,
  /** Receives why the person did not qualify (or what it measured): written to the shot diagnostics. */
  report?: (outcome: Record<string, unknown>) => void,
): Promise<{pitchDeg: number; heightM?: number; basis: "person-feet" | "person-head" | "person-axis"} | null> {
  const reject = (reason: string, values: Record<string, unknown> = {}) => {
    report?.({rejected: reason, ...values});
    return null;
  };
  const mesh = attempt.result?.mesh;
  if (!mesh?.positions?.length || !mesh.hasUvs) return reject("no MoGe mesh with UVs");
  const indices = maskIndicesForStillTime(entry, attempt.candidate.timeSec);
  let best: {points: number[]; stats: {minY: number; maxY: number; height: number}} | null = null;
  for (const index of indices) {
    const bytes = entry.masks?.[index]?.bytes;
    if (!bytes) continue;
    const bitmap = await maskBitmap(bytes).catch(() => undefined);
    if (!bitmap) continue;
    const points: number[] = [];
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let y = 0; y < bitmap.height; y++) {
      for (let x = 0; x < bitmap.width; x++) {
        if (bitmap.data[y * bitmap.width + x] > 127) {
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    const vertexCount = Math.floor(mesh.positions.length / 3);
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const u = Math.round(mesh.uvs[vertex * 2] * (bitmap.width - 1));
      const v = Math.round(mesh.uvs[vertex * 2 + 1] * (bitmap.height - 1));
      if (u < 0 || v < 0 || u >= bitmap.width || v >= bitmap.height || bitmap.data[v * bitmap.width + u] <= 127) continue;
      const px = mesh.positions[vertex * 3];
      const py = mesh.positions[vertex * 3 + 1];
      const pz = mesh.positions[vertex * 3 + 2];
      if (Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pz) && pz > 0.1) points.push(px, py, pz);
    }
    if (!best || points.length > best.points.length) best = {points, stats: {minY, maxY, height: bitmap.height}};
  }
  if (!best || best.points.length < 3 * 300) return reject("too few person points", {masks: indices.length, points: best ? best.points.length / 3 : 0, stillTimeSec: attempt.candidate.timeSec});
  const count = best.points.length / 3;
  const mean = [0, 0, 0];
  for (let index = 0; index < count; index++) for (let axis = 0; axis < 3; axis++) mean[axis] += best.points[index * 3 + axis] / count;
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let index = 0; index < count; index++) {
    const d = [0, 1, 2].map((axis) => best!.points[index * 3 + axis] - mean[axis]);
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) cov[row * 3 + col] += (d[row] * d[col]) / count;
  }
  // Main axis by power iteration, started along image "up" (camera -y).
  let axis = [0, -1, 0];
  for (let step = 0; step < 50; step++) {
    const next = [0, 1, 2].map((row) => cov[row * 3] * axis[0] + cov[row * 3 + 1] * axis[1] + cov[row * 3 + 2] * axis[2]);
    const length = Math.hypot(next[0], next[1], next[2]) || 1;
    axis = next.map((value) => value / length);
  }
  const variance = (direction: number[]) => [0, 1, 2].reduce((sum, row) => sum + direction[row] * (cov[row * 3] * direction[0] + cov[row * 3 + 1] * direction[1] + cov[row * 3 + 2] * direction[2]), 0);
  const along = variance(axis);
  const total = cov[0] + cov[4] + cov[8];
  // A standing body is clearly longer than it is wide or deep: the main axis must carry most of it.
  if (!(along > 0.6 * total)) return reject("person points not elongated", {mainAxisShare: Number((along / total).toFixed(3))});
  if (axis[1] > 0) axis = axis.map((value) => -value); // up points to the top of the image
  // A body stands roughly upright in the picture: the axis may lean in depth (the camera tilt) but
  // not sideways, and it must point mostly up the image. A floor patch under a mask fails both.
  if (!(Math.abs(axis[0]) < 0.35 && -axis[1] > 0.6)) return reject("main axis not upright in the image", {axis: axis.map((value) => Number(value.toFixed(3)))});
  const pitchDeg = (Math.atan2(-axis[2], -axis[1]) * 180) / Math.PI;
  if (!(Math.abs(pitchDeg) <= 50)) return reject("pitch beyond 50 degrees", {pitchDeg: Number(pitchDeg.toFixed(1))});
  const heights: number[] = [];
  for (let index = 0; index < count; index++) heights.push(best.points[index * 3] * axis[0] + best.points[index * 3 + 1] * axis[1] + best.points[index * 3 + 2] * axis[2]);
  heights.sort((left, right) => left - right);
  const low = heights[Math.floor(heights.length * 0.01)];
  const high = heights[Math.floor(heights.length * 0.99)];
  const feetInFrame = best.stats.maxY < best.stats.height - 3;
  const headInFrame = best.stats.minY > 2;
  // The body's extent along the axis must be human: a whole body 1.0-2.3 m, a cut one at least 0.3 m.
  const extent = high - low;
  const plausible = (value: number) => value > 0.2 && value < 6;
  // The tilt does not depend on MoGe's metric scale; the height does. With head and feet in the
  // picture the height is read scale-free from the image instead: the rays to the head row and the
  // feet row (lens fit + measured tilt) span a person of the anchor height at exactly one distance,
  // and the feet ray then sets the camera height. This is what makes a low angle come out low.
  const fov = attempt.result?.fov;
  if (feetInFrame && headInFrame && fov && Number.isFinite(fov.verticalFovDeg) && fov.verticalFovDeg > 1) {
    const focal = best.stats.height / 2 / Math.tan((fov.verticalFovDeg * Math.PI) / 360);
    const pitchRad = (pitchDeg * Math.PI) / 180;
    const elevation = (row: number) => Math.atan((best!.stats.height / 2 - row) / focal) - pitchRad;
    const head = Math.tan(elevation(best.stats.minY));
    const feet = Math.tan(elevation(best.stats.maxY));
    const distance = personHeightM / Math.max(1e-6, head - feet);
    const imageHeight = -distance * feet;
    if (head > feet && plausible(imageHeight) && distance > 0.3 && distance < 60) {
      report?.({pitchDeg: Number(pitchDeg.toFixed(1)), heightM: Number(imageHeight.toFixed(2)), distanceM: Number(distance.toFixed(2)), from: "head and feet rows", points: count});
      return {pitchDeg, heightM: imageHeight, basis: "person-feet"};
    }
  }
  // Otherwise the mesh, but only when its scale is human: dark or letterboxed footage over-scales
  // it, and then the person still gives the pitch, not the height.
  const humanExtent = feetInFrame && headInFrame ? extent > 1.0 && extent < 2.3 : extent > 0.3 && extent < 2.3;
  report?.({pitchDeg: Number(pitchDeg.toFixed(1)), extentM: Number(extent.toFixed(2)), feetInFrame, headInFrame, points: count, ...(humanExtent ? {} : {height: "not used: body extent not human"})});
  if (!humanExtent) return {pitchDeg, basis: "person-axis"};
  if (feetInFrame && plausible(-low)) return {pitchDeg, heightM: -low, basis: "person-feet"};
  if (headInFrame && plausible(personHeightM - high)) return {pitchDeg, heightM: personHeightM - high, basis: "person-head"};
  return {pitchDeg, basis: "person-axis"};
}

/** Intersection over union of two equally sized 0/255 masks (0 when the sizes differ). */
export function maskOverlap(left: {width: number; height: number; data: Uint8Array}, right: {width: number; height: number; data: Uint8Array}): number {
  if (left.width !== right.width || left.height !== right.height) return 0;
  let both = 0;
  let either = 0;
  for (let index = 0; index < left.data.length; index++) {
    const a = left.data[index] > 127;
    const b = right.data[index] > 127;
    if (a && b) both++;
    if (a || b) either++;
  }
  return either ? both / either : 0;
}

/** Pixel radius around a mask edge that also counts as person (mesh vertices on the silhouette). */
const MASK_DILATE_PX = 2;

function maskCovers(bitmap: {width: number; height: number; data: Uint8Array}, uvU: number, uvV: number): boolean {
  const u = Math.round(uvU * (bitmap.width - 1));
  const v = Math.round(uvV * (bitmap.height - 1));
  for (let dv = -MASK_DILATE_PX; dv <= MASK_DILATE_PX; dv++) {
    for (let du = -MASK_DILATE_PX; du <= MASK_DILATE_PX; du++) {
      const x = u + du;
      const y = v + dv;
      if (x >= 0 && y >= 0 && x < bitmap.width && y < bitmap.height && bitmap.data[y * bitmap.width + x] > 127) return true;
    }
  }
  return false;
}

/**
 * Turn a MoGe attempt's mesh into stage-space set blocks: drop the person points (mask
 * projection plus a root cylinder fallback), drop implausible space, voxelize per depth band
 * (0.12 m near, 0.25 m mid, 0.5 m far) and merge neighbours into boxes. Reuses the mesh already
 * read for the floor fit. `floor` is the measured plane, or for a shot without a usable floor
 * a level floor tilted by the estimated pitch at the estimated camera height: the
 * set is rebuilt for every shot that has a MoGe mesh, not only for measured ones.
 */
async function buildPointcloudSet(input: {
  entry: PreparedShot;
  attempt: Attempt;
  floor: Pick<FloorPlane, "normal" | "offsetM">;
  persons: PersonTrack[];
}): Promise<{set: SceneBlock[]; setSource: "moge-pointcloud"}> {
  const mesh = input.attempt.result?.mesh;
  const empty = {set: [] as SceneBlock[], setSource: "moge-pointcloud" as const};
  if (!mesh?.positions?.length) return empty;
  const basis = sceneBasis(input.floor);
  const roots = input.persons.flatMap((person) => person.keyframes.map((keyframe) => ({xM: keyframe.xM, zM: keyframe.zM})));
  const maskIndices = mesh.hasUvs ? maskIndicesForStillTime(input.entry, input.attempt.candidate.timeSec) : [];
  const bitmaps = (await Promise.all(maskIndices.map((index) => maskBitmap(input.entry.masks![index].bytes).catch(() => undefined)))).filter(
    (bitmap): bitmap is {width: number; height: number; data: Uint8Array} => bitmap !== undefined,
  );
  const stagePoints: number[] = [];
  const vertexCount = Math.floor(mesh.positions.length / 3);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const cameraPoint: [number, number, number] = [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
    if (!Number.isFinite(cameraPoint[0]) || !Number.isFinite(cameraPoint[1]) || !Number.isFinite(cameraPoint[2])) continue;
    if (bitmaps.length && bitmaps.some((bitmap) => maskCovers(bitmap, mesh.uvs[vertex * 2], mesh.uvs[vertex * 2 + 1]))) continue;
    const stage = stagePointFromCamera(input.floor, basis, cameraPoint);
    // Fallback person removal: a 0.5 m cylinder, 0..2.2 m, around every person root.
    const inPerson = roots.some((root) => stage[1] > -0.2 && stage[1] < 2.2 && Math.hypot(stage[0] - root.xM, stage[2] - root.zM) < 0.5);
    if (inPerson) continue;
    stagePoints.push(stage[0], stage[1], stage[2]);
  }
  if (!stagePoints.length) return empty;
  const subjectDistance = roots.length ? Math.min(...roots.map((root) => Math.hypot(root.xM, root.zM))) : undefined;
  const set = voxelizeSetBands(Float32Array.from(stagePoints), {
    minPointsPerCell: 12,
    personRoots: roots,
    personClearanceM: 0.4,
    subjectDistanceM: subjectDistance,
  });
  return {set, setSource: "moge-pointcloud"};
}

/** The MoGe attempt whose mesh rebuilds the set of a shot without an accepted floor: the first with a mesh and a lens fit. */
function setAttempt(entry: PreparedShot): Attempt | undefined {
  return entry.attempts.find((attempt) => attempt.result?.mesh && attempt.result.fov) ?? entry.attempts.find((attempt) => attempt.result?.mesh);
}

/** Camera pitch for a shot without an accepted floor: a gate-failed plane only while near level (<= 30 deg tilt). */
function estimatedPitchDeg(entry: PreparedShot): number {
  const floorAttempt = entry.attempts.find((attempt) => attempt.result?.floor);
  const tiltDeg = floorAttempt?.result?.floor ? floorPlausibility(floorAttempt.result.floor).tiltDeg : Number.POSITIVE_INFINITY;
  return floorAttempt?.result?.floor && tiltDeg <= 30 ? cameraFromFloor({...floorAttempt.result.floor, confidence: 0}).pitchDeg : 0;
}

/** Camera height for a shot without an accepted floor: a measured neighbour's (index +-3), else eye level. */
function neighbourCameraHeight(entry: PreparedShot, measuredGeometries: ShotGeometry[]): {heightM: number; neighbor?: ShotGeometry} {
  const neighbor = measuredGeometries
    .filter((geometry) => Math.abs(geometry.shotIndex - entry.shot.index) <= 3)
    .sort((left, right) => Math.abs(left.shotIndex - entry.shot.index) - Math.abs(right.shotIndex - entry.shot.index))[0];
  return neighbor ? {heightM: neighbor.camera.heightM, neighbor} : {heightM: eyeLevelCameraHeightM(PERSON_HEIGHT_ANCHOR_M)};
}

/**
 * A shot with no person (or no localizable person) and no accepted floor still shows its place
 *: the camera from the MoGe lens fit, the estimated pitch and a neighbour's (or eye
 * level) height, and the set rebuilt from the same MoGe mesh. No figure is invented. Quality is
 * "estimated"; a shot with an accepted floor is measured by analyzeAcceptedShot instead.
 */
async function buildEnvironmentShot(entry: PreparedShot, params: AnalysisParams, measuredGeometries: ShotGeometry[], note: string): Promise<RunResult> {
  const attemptModelMs = entry.attempts.reduce((sum, attempt) => sum + (attempt.result?.modelMs ?? 0), 0);
  const runtimeMs = attemptModelMs + (entry.sam3Execution?.durationMs ?? 0);
  const evidence: GeometryEvidence = {
    persons: null,
    stillWidth: entry.candidates[0]?.width ?? 0,
    stillHeight: entry.candidates[0]?.height ?? 0,
    attempts: entry.attempts.map(attemptToEvidence),
    rawPersonHeightsM: [],
    personFrameTimesSec: [...entry.personClip.frameTimesSec],
    sam3MaskCount: entry.sam3Execution?.outputs["9002"]?.length ?? 0,
  };
  const attempt = setAttempt(entry);
  const fov = attempt?.result?.fov;
  if (!attempt || !fov) {
    evidence.skipReason = `${note}; no MoGe mesh with a lens fit to rebuild the set (tried ${describeAttempts(entry)})`;
    return {error: evidence.skipReason, evidence, runtimeMs};
  }
  const {heightM} = neighbourCameraHeight(entry, measuredGeometries);
  const pitchDeg = estimatedPitchDeg(entry);
  const floor = pitchedLevelFloor(heightM, pitchDeg);
  const built = await buildPointcloudSet({entry, attempt, floor, persons: []}).catch(() => ({set: [] as SceneBlock[], setSource: "moge-pointcloud" as const}));
  if (!built.set.length) {
    evidence.skipReason = `${note}; the MoGe mesh gave no set blocks`;
    return {error: evidence.skipReason, evidence, runtimeMs};
  }
  const geometry: ShotGeometry = {
    shotIndex: entry.shot.index,
    floor: toContractFloor(syntheticLevelFloor(heightM)),
    camera: {
      heightM: round(heightM, 3),
      pitchDeg: round(pitchDeg, 2),
      yawDeg: 0,
      fovDeg: round(fov.horizontalFovDeg, 2),
      lensMm: round(lensMmFromHorizontalFov(fov.horizontalFovDeg), 1),
      confidence: 0.2,
    },
    persons: [],
    set: built.set,
    setSource: built.setSource,
    source: {model: params.models.geometry, keyframeSeconds: [round(attempt.candidate.timeSec, 3)], runtimeMs},
    quality: "estimated",
  };
  evidence.quality = "estimated";
  evidence.setBlockCount = built.set.length;
  evidence.setSource = built.setSource;
  return {geometry, evidence, runtimeMs};
}

/** Person pass for an accepted floor + the final ShotGeometry. */
async function analyzeAcceptedShot(client: ComfyAnalysisClient, entry: PreparedShot, params: AnalysisParams, artifactsDir: string): Promise<RunResult> {
  const accepted = entry.accepted!;
  const result = accepted.result!;
  const floor = result.floor!;
  const fov = result.fov ?? null;
  const cameraMeasurement = result.camera!;
  const attempts = entry.attempts.map(attemptToEvidence);
  const baseEvidence: GeometryEvidence = {
    persons: null,
    stillWidth: accepted.candidate.width,
    stillHeight: accepted.candidate.height,
    attempts,
    acceptedStillTimeSec: round(accepted.candidate.timeSec, 3),
    rawPersonHeightsM: [],
    personFrameTimesSec: [...entry.personClip.frameTimesSec],
    sam3MaskCount: entry.sam3Execution?.outputs["9002"]?.length ?? 0,
  };
  const attemptModelMs = entry.attempts.reduce((sum, attempt) => sum + (attempt.result?.modelMs ?? 0), 0);
  const sam3ModelMs = entry.sam3Execution?.durationMs ?? 0;
  const runtimeMs = attemptModelMs + sam3ModelMs;
  const diagnosticsDir = join(artifactsDir, "diagnostics", `shot-${entry.shot.index}`);
  if (entry.environment) {
    // SAM3 confirmed no person: the measured floor places the camera, the mesh rebuilds the set.
    const built = await buildPointcloudSet({entry, attempt: accepted, floor, persons: []}).catch(() => ({set: [] as SceneBlock[], setSource: "moge-pointcloud" as const}));
    baseEvidence.setBlockCount = built.set.length;
    baseEvidence.setSource = built.setSource;
    if (!built.set.length) {
      baseEvidence.skipReason = `${entry.environment}; the MoGe mesh gave no set blocks`;
      return {error: baseEvidence.skipReason, evidence: baseEvidence, runtimeMs};
    }
    const geometry: ShotGeometry = {
      shotIndex: entry.shot.index,
      floor: toContractFloor(floor),
      camera: toContractCamera(cameraMeasurement),
      persons: [],
      set: built.set,
      setSource: built.setSource,
      source: {model: params.models.geometry, keyframeSeconds: [round(accepted.candidate.timeSec, 3)], runtimeMs},
      quality: "measured",
    };
    return {geometry, evidence: baseEvidence, runtimeMs};
  }
  // A shot without a person root falls through to the estimate and the environment rebuild.
  let persons: PersonAnalysis;
  let masks: MaskImage[] = [];
  try {
    masks = entry.masks ?? [];
    if (!masks.length) for (const file of entry.sam3Execution?.outputs["9002"] ?? []) masks.push({filename: file.filename, bytes: await client.download(file)});
    const fxPx = fov ? fov.fxPx : accepted.candidate.width / (2 * Math.tan((cameraMeasurement.fovDeg * Math.PI) / 360));
    const fyPx = fov ? fov.fyPx : fxPx;
    const intrinsics: CameraIntrinsics = {
      width: entry.personClip.width,
      height: entry.personClip.height,
      fxPx: fxPx * (entry.personClip.width / accepted.candidate.width),
      fyPx: fyPx * (entry.personClip.height / accepted.candidate.height),
    };
    persons = await analyzePersons({masks, frameTimesSec: entry.personClip.frameTimesSec, intrinsics, floor});
  } catch (error) {
    const bundle = await writePersonPassDiagnostics({dir: diagnosticsDir, entry, masks, persons: null, reason: `analysis failed: ${errorText(error)}`}).catch(() => undefined);
    if (bundle) baseEvidence.personPassDiagnostics = bundle;
    return {error: `person pass could not analyse the SAM3 masks; kept blockout: ${errorText(error)}`, evidence: baseEvidence, runtimeMs};
  }
  baseEvidence.persons = persons;
  baseEvidence.rawPersonHeightsM = persons.diagnostics.rawHeightsM;
  if (!persons.tracks.length) {
    const skippedReasons = [...new Set(persons.diagnostics.skipped.map((skip) => skip.reason))];
    const onlyHeadCut = skippedReasons.length > 0 && skippedReasons.every((reason) => reason.startsWith("head outside the top edge"));
    const detail = persons.diagnostics.maskCount === 0
      ? "SAM3 found no person mask"
      : onlyHeadCut
        ? "every person mask is cut by the top edge (close-up; no head point to anchor)"
        : `${persons.diagnostics.maskCount} masks, ${persons.diagnostics.skippedCount} unusable${skippedReasons[0] ? ` (${skippedReasons[0]})` : ""}`;
    const reason = `no person root could be localized; kept blockout (${detail})`;
    // Keep the person-clip frames, masks and mask bounding boxes on disk for a false-negative audit.
    const bundle = await writePersonPassDiagnostics({dir: diagnosticsDir, entry, masks, persons, reason}).catch(() => undefined);
    if (bundle) baseEvidence.personPassDiagnostics = bundle;
    return {error: reason, evidence: baseEvidence, runtimeMs};
  }
  const geometry: ShotGeometry = {
    shotIndex: entry.shot.index,
    floor: toContractFloor(floor),
    camera: toContractCamera(cameraMeasurement),
    persons: persons.tracks,
    source: {
      model: `${params.models.geometry} / ${params.models.persons}`,
      keyframeSeconds: [round(accepted.candidate.timeSec, 3)],
      runtimeMs,
    },
  };
  // Set blocks from the same MoGe mesh read for the floor fit: person points removed, voxelized.
  const builtSet = await buildPointcloudSet({entry, attempt: accepted, floor, persons: persons.tracks}).catch(() => ({set: [] as SceneBlock[], setSource: "moge-pointcloud" as const}));
  geometry.set = builtSet.set;
  geometry.setSource = builtSet.setSource;
  baseEvidence.setBlockCount = builtSet.set.length;
  baseEvidence.setSource = builtSet.setSource;
  return {geometry, evidence: baseEvidence, runtimeMs};
}


/**
 * Save everything needed to audit a "no person root" rejection: the person-clip
 * frames (the keyframe stills SAM3 actually saw), the mask PNGs in ComfyUI's batch
 * order, the per-mask bounding boxes and the skip reasons. This is what catches a
 * silent false negative (e.g. a wide shot whose top-scoring mask is background).
 */
async function writePersonPassDiagnostics(input: {
  dir: string;
  entry: PreparedShot;
  masks: MaskImage[];
  persons: PersonAnalysis | null;
  reason: string;
}): Promise<string> {
  await mkdir(input.dir, {recursive: true});
  const artifactsDir = dirname(dirname(input.entry.personClip.path));
  const frameFiles: string[] = [];
  const frameTimesSec = input.entry.personClip.frameTimesSec;
  for (let index = 0; index < frameTimesSec.length; index++) {
    const source = join(artifactsDir, "stills", `shot-${input.entry.shot.index}-kf-${index}.jpg`);
    const name = `frame-${index}-${round(frameTimesSec[index], 3).toFixed(3)}s.jpg`;
    try {
      await copyFile(source, join(input.dir, name));
      frameFiles.push(name);
    } catch {
      // The frame is already missing upstream; the mask stats still explain the decision.
    }
  }
  const maskFiles: string[] = [];
  for (let index = 0; index < input.masks.length; index++) {
    const name = `mask-${String(index).padStart(2, "0")}.png`;
    await writeFile(join(input.dir, name), input.masks[index].bytes);
    maskFiles.push(name);
  }
  const payload = {
    shotIndex: input.entry.shot.index,
    reason: input.reason,
    personFrameTimesSec: frameTimesSec,
    clip: {path: input.entry.personClip.path, width: input.entry.personClip.width, height: input.entry.personClip.height, fps: input.entry.personClip.fps},
    frames: frameFiles,
    masks: maskFiles,
    maskOrder: input.masks.map((mask) => mask.filename),
    maskStats: input.persons?.diagnostics.maskStats ?? [],
    skipped: input.persons?.diagnostics.skipped ?? [],
    heightPriorM: input.persons?.diagnostics.heightPriorM ?? null,
    tracks: input.persons?.tracks ?? [],
  };
  const path = join(input.dir, "person-pass.json");
  await writeFile(path, JSON.stringify(payload, null, 2));
  return path;
}
export function toContractCamera(camera: CameraMeasurement): GeometryCamera {
  return {
    heightM: round(camera.heightM, 3),
    pitchDeg: round(camera.pitchDeg, 2),
    yawDeg: 0,
    fovDeg: round(camera.fovDeg, 2),
    lensMm: round(camera.lensMm, 1),
    confidence: round(camera.confidence, 3),
  };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "");
}

async function readFileBytes(path: string): Promise<Uint8Array> {
  return readFile(path);
}

/** Sum of the real ComfyUI execution times of every MoGe attempt and SAM3 prompt in the batch. */
function batchModelMs(prepared: PreparedShot[]): number {
  let total = 0;
  for (const entry of prepared) {
    for (const attempt of entry.attempts) total += attempt.result?.modelMs ?? 0;
    total += entry.sam3Execution?.durationMs ?? 0;
  }
  return total;
}

/** One error per shot: a shot can fail in several phases, the first message is the useful one. */
function dedupeErrors(errors: Array<{shotIndex: number; message: string}>): Array<{shotIndex: number; message: string}> {
  const seen = new Set<number>();
  return errors.filter((entry) => {
    if (seen.has(entry.shotIndex)) return false;
    seen.add(entry.shotIndex);
    return true;
  });
}

/*
 *: analyse a YouTube video WITHOUT downloading it.
 *
 * The embedded player (ReferenceMedia's iframe) plays the video in the tab the
 * person is already looking at. On the explicit "Analyze reference" click the
 * person shares the tab through getDisplayMedia; a hidden <video> reads the
 * captured stream and this module crops it to the player's screen rectangle.
 * Every frame that survives the ad/buffer filter produces a 48x27 luma
 * histogram (cuts), a 320 px JPEG (the vision decisions) and a 640 px JPEG
 * (the geometry stills). No video file is written or kept: only the chosen
 * keyframe JPEGs survive, and the server stores those as analysis input.
 *
 * The clock is the player clock, never the wall clock: samples are timestamped
 * with the currentTime the embed reports over its iframe API messages. A sample
 * is recorded only while the player reports PLAYING and its time advanced since
 * the previous sample, so an ad, a buffering stall or a pause contributes no
 * frames and no timestamps. When the time stays frozen for longer than
 * `CAPTURE_FROZEN_SKIP_MS` the capture reports `skipping` (the UI says
 * "Skipping ad/buffer") and resumes on the first advancing sample.
 *
 * Everything below the browser edge is pure and unit-tested without a real
 * capture permission: the histogram, the cut detector, the shot/keyframe
 * selection, the analysis request builder, the capture crop mapping, the
 * ad/pause sample gate, and `analyseYoutubeVideo`, which takes the server
 * client and the capture engine as injected dependencies so a cache hit can be
 * proven not to ask for a tab.
 */

import type {AnalysisCaptureParams, AnalysisFrameScanRequest, AnalysisScan, KeyframeRole} from "./analysis-contract";

/** Sample rate of the cut scan (the player clock only gets one sample per clock step). */
export const CAPTURE_FPS = 8;
/** Keyframes kept per shot: start, middle, end (the server's stills order). */
export const CAPTURE_KEYFRAMES = 3;
/** Width of the geometry still: the analysis pyramid's geometry width. */
export const CAPTURE_STILL_WIDTH = 640;
/** Width of the decision frame: the analysis pyramid's decision width. */
export const CAPTURE_DECISION_WIDTH = 320;
export const CAPTURE_STILL_QUALITY = 0.82;
export const CAPTURE_DECISION_QUALITY = 0.8;
/** The tiny frame the cut histogram is measured on. */
export const CAPTURE_HISTOGRAM_WIDTH = 48;
export const CAPTURE_HISTOGRAM_HEIGHT = 27;
export const CAPTURE_HISTOGRAM_BINS = 32;
/** Luma-histogram distance above which two consecutive samples count as different shots. */
export const CAPTURE_CUT_THRESHOLD = 0.32;
/** Minimum length between two hard cuts; closer changes are the same transition. */
export const CAPTURE_CUT_MIN_SHOT_SEC = 0.5;
/** Shorter segments at the clip edges are merged into their neighbour, not kept as shots. */
export const CAPTURE_SHOT_MIN_SEC = 0.2;
/** The player is played at 2x where the video allows it; the score clock stays the player's. */
export const CAPTURE_PLAYBACK_RATE = 2;
/** Hard upper bound of a capture, in player seconds (15 minutes). */
export const CAPTURE_MAX_SECONDS = 900;
/** Seconds a section capture starts before its start, so the player's title bar has faded. */
export const SECTION_PREROLL_SEC = 10;
/** A player that reports PLAYING but whose clock did not move for this long is an ad or a buffer. */
export const CAPTURE_FROZEN_SKIP_MS = 750;
/** Once a shot has more frames than this, every other still is dropped to bound memory. */
export const CAPTURE_MAX_OPEN_FRAMES = 800;
/** The UI stage line is refreshed at most this often while the player runs. */
export const CAPTURE_PROGRESS_INTERVAL_MS = 200;
/** How long the embedded player may take to answer the iframe-API handshake. */
export const CAPTURE_PLAYER_READY_MS = 8000;

const DEFAULT_ASPECT_RATIO = 16 / 9;
const MIN_CROP_WIDTH = 32;
const MIN_CROP_HEIGHT = 18;
const SEEK_WAIT_MS = 6000;
const START_WATCHDOG_MS = 25_000;
const SKIPPING_WATCHDOG_MS = 180_000;
/** A player that stays paused or frozen this long cannot continue the capture. */
const STALL_WATCHDOG_MS = 15_000;

export type LumaHistogram = number[];

/** One recorded frame of the capture: the player time is the only timestamp it carries. */
export type CaptureSample = {
  /** Player clock seconds at the moment the frame was drawn; strictly increasing. */
  timeSec: number;
  /** Normalized 32-bin luma histogram of the cropped player area. */
  histogram: LumaHistogram;
  /** 320 px JPEG data URL for the vision decisions ("" when pruned to bound memory). */
  frame320: string;
  /** 640 px JPEG data URL for the geometry stills ("" when pruned to bound memory). */
  still640: string;
  /** Still size; the aspect ratio of the cropped player area. */
  width: number;
  height: number;
  /** The embed's player state at that sample (1 = playing). */
  playerState: number;
};

export type HistogramSample = {timeSec: number; histogram: LumaHistogram};

/** What the capture shows the person while the video runs. */
export type CaptureProgress = {
  playerTimeSec: number;
  /** Player duration when the embed reports it, else 0. */
  durationSec: number;
  /** Hard cuts detected so far (player seconds), in playback order. */
  cuts: number[];
  /** True while an ad or a buffer freezes the player clock. */
  skipping: boolean;
  playedSeconds: number;
};

export type CapturedKeyframe = {index: number; timeSec: number; role: KeyframeRole; frame320: string; still640: string};

export type CapturedShot = {index: number; startSec: number; endSec: number; keyframes: CapturedKeyframe[]};

/** The engine's answer: only histograms, keyframe JPEGs and player-clock facts. No video. */
export type CaptureResult = {
  samples: CaptureSample[];
  /** Player duration of the captured video in seconds. */
  durationSec: number;
  /** Width of the 640 stills. */
  width: number;
  /** Height of the 640 stills (from the cropped player area). */
  height: number;
  aspectRatio: number;
  /** Player seconds actually observed advancing (2x playback still counts as player seconds). */
  playedSeconds: number;
  /** Wall seconds spent on ads/buffers/pauses instead of the video. */
  skippedSeconds: number;
  cuts: number[];
};

/* ── Histograms and cuts (pure) ───────────────────────────────────────────── */

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const clampNumber = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * A 48x27 (or any size) RGBA frame to a normalized 32-bin luma histogram.
 * Rec. 601 luma keeps a cut between two equally saturated colours visible even
 * when their RGB histograms overlap.
 */
export function histogramOf(pixels: ArrayLike<number>, width: number, height: number): LumaHistogram {
  const bins = new Array<number>(CAPTURE_HISTOGRAM_BINS).fill(0);
  const pixelsAvailable = Math.floor(pixels.length / 4);
  const total = Math.max(1, Math.min(pixelsAvailable, Math.max(1, Math.floor(width) * Math.floor(height))));
  const step = 256 / CAPTURE_HISTOGRAM_BINS;
  for (let index = 0; index < total; index++) {
    const offset = index * 4;
    const luma = 0.299 * (pixels[offset] ?? 0) + 0.587 * (pixels[offset + 1] ?? 0) + 0.114 * (pixels[offset + 2] ?? 0);
    const bin = Math.min(CAPTURE_HISTOGRAM_BINS - 1, Math.max(0, Math.floor(luma / step)));
    bins[bin] += 1;
  }
  return bins.map((count) => count / total);
}

/** Total-variation distance of two normalized histograms: 0 = identical, 1 = unrelated. */
export function histogramDistance(left: LumaHistogram, right: LumaHistogram): number {
  const bins = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < bins; index++) sum += Math.abs((left[index] ?? 0) - (right[index] ?? 0));
  return sum / 2;
}

/**
 * The one cut decision shared by the online detector (capture progress) and the
 * final shot builder: the player time where two consecutive samples differ
 * enough, unless it lands inside the minimum shot length of the previous cut.
 * The time is the midpoint between the two samples, so the boundary sits
 * between the last frame of the old shot and the first frame of the new one.
 */
function cutBetween(previous: HistogramSample, current: HistogramSample, lastCutTimeSec: number, threshold = CAPTURE_CUT_THRESHOLD, minShotSec = CAPTURE_CUT_MIN_SHOT_SEC): number | null {
  const distance = histogramDistance(previous.histogram, current.histogram);
  if (!(distance >= threshold)) return null;
  const timeSec = round3((previous.timeSec + current.timeSec) / 2);
  if (timeSec - lastCutTimeSec < minShotSec) return null;
  return timeSec;
}

/**
 * Hard-cut times from histogram samples. A cut is a frame-pair histogram
 * distance above `threshold`; a gradual fade moves the histogram a little per
 * sample and never clears it. Two changes closer than `minShotSec` are one
 * transition (the first one wins, matching the online detector).
 */
export function detectCutsFromHistograms(samples: HistogramSample[], options: {threshold?: number; minShotSec?: number} = {}): number[] {
  if (samples.length < 2) return [];
  const threshold = options.threshold ?? CAPTURE_CUT_THRESHOLD;
  const minShotSec = options.minShotSec ?? CAPTURE_CUT_MIN_SHOT_SEC;
  const cuts: number[] = [];
  let lastCutTime = Number.NEGATIVE_INFINITY;
  for (let index = 1; index < samples.length; index++) {
    const cut = cutBetween(samples[index - 1], samples[index], lastCutTime, threshold, minShotSec);
    if (cut === null) continue;
    cuts.push(cut);
    lastCutTime = cut;
  }
  return cuts;
}

/* ── Shots and keyframes (pure) ───────────────────────────────────────────── */

type FramedSample = CaptureSample;

const hasFrames = (sample: FramedSample): boolean => Boolean(sample.frame320) && Boolean(sample.still640);

const roleRank: Record<KeyframeRole, number> = {start: 0, middle: 1, end: 2, motion: 3};

/** The framed samples inside a shot window (the server tolerates +-0.1 s around a shot). */
const shotWindowSamples = (samples: FramedSample[], startSec: number, endSec: number): FramedSample[] =>
  samples.filter((sample) => hasFrames(sample) && sample.timeSec >= startSec - 0.09 && sample.timeSec <= endSec + 0.09);

/** The sample nearest to a target time that was not already assigned to another role. */
function nearestSample(samples: FramedSample[], targetSec: number, used: Set<number>): FramedSample | null {
  let best: FramedSample | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    if (used.has(sample.timeSec)) continue;
    const distance = Math.abs(sample.timeSec - targetSec);
    if (distance >= bestDistance) continue;
    best = sample;
    bestDistance = distance;
  }
  return best;
}

/**
 * The start/middle/end stills of one shot: nearest captured sample to the
 * intended keyframe time. Very short shots keep only as many distinct
 * keyframes as they actually have frames for (start+end for two frames, the
 * middle for one), which is what the server contract accepts.
 */
function pickKeyframes(samples: FramedSample[], startSec: number, endSec: number, keyframes = CAPTURE_KEYFRAMES): CapturedKeyframe[] {
  const windowSamples = shotWindowSamples(samples, startSec, endSec);
  if (!windowSamples.length) return [];
  const span = Math.max(0.01, endSec - startSec);
  const inset = clampNumber(span * 0.08, 0.04, 0.35);
  const wanted: KeyframeRole[] = windowSamples.length <= 1 || keyframes <= 1
    ? ["middle"]
    : keyframes >= 3 && windowSamples.length >= 3
      ? ["start", "middle", "end"]
      : keyframes >= 2 && windowSamples.length === 2
        ? ["start", "end"]
        : (["start", "middle", "end"] as KeyframeRole[]).slice(0, Math.max(1, Math.min(windowSamples.length, keyframes)));
  const targets: Record<KeyframeRole, number> = {start: startSec + inset, middle: (startSec + endSec) / 2, end: endSec - inset, motion: (startSec + endSec) / 2};
  const used = new Set<number>();
  const picked: CapturedKeyframe[] = [];
  for (const role of wanted) {
    const sample = nearestSample(windowSamples, targets[role], used);
    if (!sample) continue;
    used.add(sample.timeSec);
    picked.push({
      // Milliseconds as the frame index: stable, unique enough across shots and inside the server's bound.
      index: Math.round(sample.timeSec * 1000),
      timeSec: round3(sample.timeSec),
      role,
      frame320: sample.frame320,
      still640: sample.still640,
    });
  }
  return picked.sort((left, right) => roleRank[left.role] - roleRank[right.role]);
}

/**
 * The shot list of a capture. Cuts closer than the minimum shot length to the
 * clip start or end are merged into their neighbour; each shot gets its
 * start/middle/end keyframes from the captured samples, with the real player
 * timestamps. `cuts` normally comes from `detectCutsFromHistograms`.
 */
export function captureShotsFromSamples(samples: CaptureSample[], cuts: number[], durationSec: number, keyframes = CAPTURE_KEYFRAMES): CapturedShot[] {
  const framed = samples.filter(hasFrames);
  if (!framed.length || !Number.isFinite(durationSec) || durationSec <= 0) return [];
  const bounds: number[] = [0];
  for (const cut of [...cuts].sort((left, right) => left - right)) {
    const timeSec = round3(cut);
    const start = bounds[bounds.length - 1];
    if (!(timeSec > start)) continue;
    // A shot shorter than the minimum at either edge would make a meaningless keyframe set.
    if (timeSec - start < CAPTURE_SHOT_MIN_SEC || durationSec - timeSec < CAPTURE_SHOT_MIN_SEC) continue;
    bounds.push(timeSec);
  }
  bounds.push(round3(durationSec));
  const shots: CapturedShot[] = [];
  for (let index = 0; index < bounds.length - 1; index++) {
    const startSec = bounds[index];
    const endSec = bounds[index + 1];
    if (!(endSec - startSec > 0.01)) continue;
    const keyframeList = pickKeyframes(framed, startSec, endSec, keyframes);
    if (!keyframeList.length) continue;
    shots.push({index: shots.length, startSec, endSec, keyframes: keyframeList});
  }
  return shots;
}

/**
 * The client's captured analysis request: player-clock shot boundaries,
 * 3 keyframes per shot, 320 px decision frames and 640 px geometry stills in
 * the same order. The clip has no file, so its facts come from the capture:
 * duration from the player, size from the cropped still.
 */
export function framesToScanRequest(
  videoId: string,
  samples: CaptureSample[],
  capture: AnalysisCaptureParams,
  clip?: {durationSec?: number; width?: number; height?: number; aspectRatio?: number},
): AnalysisFrameScanRequest {
  const framed = samples.filter(hasFrames);
  const first = framed[0];
  const last = framed[framed.length - 1];
  const derivedAspect = first ? first.width / Math.max(1, first.height) : DEFAULT_ASPECT_RATIO;
  const aspectRatio = clampNumber(clip?.aspectRatio ?? (Number.isFinite(derivedAspect) && derivedAspect > 0 ? derivedAspect : DEFAULT_ASPECT_RATIO), 0.1, 10);
  const width = Math.max(16, Math.round(clip?.width ?? CAPTURE_STILL_WIDTH));
  const height = Math.max(16, Math.round(clip?.height ?? width / aspectRatio));
  // Without an explicit player duration the captured time span is the honest duration (the engine
  // always passes the embed's own duration; this default keeps the pure builder self-contained).
  const durationSec = round3(Math.max(0.2, clip?.durationSec ?? (last ? last.timeSec : 0.2)));
  const cuts = detectCutsFromHistograms(samples);
  const shots = captureShotsFromSamples(framed, cuts, durationSec, capture.keyframes);
  if (!shots.length) throw new Error("No usable frames were captured from the player. Keep the player fully visible while the video runs and try again.");
  return {
    videoId,
    capture,
    clip: {durationSec, width, height, aspectRatio: round3(aspectRatio)},
    shots: shots.map((shot) => ({
      index: shot.index,
      startSec: shot.startSec,
      endSec: shot.endSec,
      keyframes: shot.keyframes.map((keyframe) => ({index: keyframe.index, timeSec: keyframe.timeSec, role: keyframe.role})),
      frames: shot.keyframes.map((keyframe) => keyframe.frame320),
      stills: shot.keyframes.map((keyframe) => ({timeSec: keyframe.timeSec, role: keyframe.role, dataUrl: keyframe.still640})),
    })),
  };
}

/* ── Captured-tab geometry (pure) ─────────────────────────────────────────── */

export type CaptureScreenRect = {left: number; top: number; width: number; height: number};

/**
 * Map the player's rectangle (CSS pixels relative to the page viewport) onto the
 * captured picture (device pixels of the shared surface). The scale is derived
 * from the captured size and the viewport size, so browser zoom and
 * devicePixelRatio are both handled. Only the part of the player that is
 * actually visible is captured; a player that is scrolled out of view is not a
 * frame and the capture skips that tick.
 */
/**
 * Letterbox bars of one frame, from the mean brightness of every row (top to bottom, 0..255): the
 * rows at the top and bottom that stay black. A wide film in the 16:9 player carries them, and a
 * mask that ends at a bar edge would otherwise read as a head or feet inside the frame. Bars count
 * only when both are present, about equal (a night sky is not a bar) and each under a quarter.
 * The mean, not the brightest pixel: burned-in subtitles sit inside the bottom bar.
 */
export function detectLetterbox(rowMax: readonly number[], threshold = 10): {top: number; bottom: number} | null {
  const rows = rowMax.length;
  if (rows < 8) return null;
  let top = 0;
  while (top < rows && rowMax[top] < threshold) top++;
  let bottom = 0;
  while (bottom < rows - top && rowMax[rows - 1 - bottom] < threshold) bottom++;
  const minBar = Math.max(1, Math.round(rows * 0.03));
  if (top < minBar || bottom < minBar) return null;
  if (top > rows / 4 || bottom > rows / 4) return null;
  if (Math.abs(top - bottom) > Math.max(2, rows * 0.03)) return null;
  return {top: top / rows, bottom: bottom / rows};
}

export function captureCropRect(input: {rect: CaptureScreenRect; viewport: {width: number; height: number}; capture: {width: number; height: number}}): {x: number; y: number; width: number; height: number} | null {
  const {rect, viewport, capture} = input;
  if (!(viewport.width > 0) || !(viewport.height > 0) || !(capture.width > 0) || !(capture.height > 0)) return null;
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewport.width, rect.left + rect.width);
  const bottom = Math.min(viewport.height, rect.top + rect.height);
  const visibleWidth = right - left;
  const visibleHeight = bottom - top;
  if (visibleWidth < MIN_CROP_WIDTH || visibleHeight < MIN_CROP_HEIGHT) return null;
  // The captured frame shows the viewport scaled uniformly and centred: when the page area changes
  // after the share started (Chrome's "sharing this tab" bar takes height), the stream keeps its
  // size and pads the content. Separate x/y scales would push the crop down and cut the picture.
  const scale = Math.min(capture.width / viewport.width, capture.height / viewport.height);
  const offsetX = (capture.width - viewport.width * scale) / 2;
  const offsetY = (capture.height - viewport.height * scale) / 2;
  const x = clampNumber(Math.round(offsetX + left * scale), 0, Math.max(0, capture.width - 1));
  const y = clampNumber(Math.round(offsetY + top * scale), 0, Math.max(0, capture.height - 1));
  const width = clampNumber(Math.round(visibleWidth * scale), 1, capture.width - x);
  const height = clampNumber(Math.round(visibleHeight * scale), 1, capture.height - y);
  if (width < MIN_CROP_WIDTH || height < MIN_CROP_HEIGHT) return null;
  return {x, y, width, height};
}

/* ── The ad/pause sample gate (pure) ──────────────────────────────────────── */

export type SampleGateReading = {record: boolean; skipping: boolean};

/**
 * The rule that turns player-clock readings into recorded samples:
 * - record only while the player reports PLAYING,
 * - record only when the player clock advanced since the last recorded sample
 *   (never two frames at the same player time, never a clock that runs backwards),
 * - while PLAYING but frozen for more than `frozenMs`, report `skipping`
 *   (a pre-roll ad, a buffer) and record nothing; the next advancing reading
 *   resumes normally.
 * A pause is not an ad: it clears the frozen timer without a skipping hint.
 */
export class PlayerSampleGate {
  readonly #minAdvanceSec: number;
  readonly #frozenMs: number;
  #lastTimeSec: number | null = null;
  #lastRecordMs: number | null = null;
  #frozenSinceMs: number | null = null;
  #skipping = false;

  constructor(options: {minAdvanceSec?: number; frozenMs?: number} = {}) {
    this.#minAdvanceSec = Math.max(0.001, options.minAdvanceSec ?? 0.02);
    this.#frozenMs = Math.max(0, options.frozenMs ?? CAPTURE_FROZEN_SKIP_MS);
  }

  get lastTimeSec(): number | null {
    return this.#lastTimeSec;
  }

  get skipping(): boolean {
    return this.#skipping;
  }

  admit(playerTimeSec: number, playing: boolean, nowMs: number): SampleGateReading {
    if (!Number.isFinite(playerTimeSec)) return {record: false, skipping: this.#skipping};
    if (!playing) {
      this.#frozenSinceMs = null;
      this.#skipping = false;
      return {record: false, skipping: false};
    }
    if (this.#lastTimeSec === null) {
      this.#lastTimeSec = playerTimeSec;
      this.#lastRecordMs = nowMs;
      this.#frozenSinceMs = null;
      this.#skipping = false;
      return {record: true, skipping: false};
    }
    if (playerTimeSec > this.#lastTimeSec + this.#minAdvanceSec) {
      this.#lastTimeSec = playerTimeSec;
      this.#lastRecordMs = nowMs;
      this.#frozenSinceMs = null;
      this.#skipping = false;
      return {record: true, skipping: false};
    }
    // Frozen: measure from the last actual advance, so a coarse iframe clock update is not an ad.
    if (this.#frozenSinceMs === null) this.#frozenSinceMs = this.#lastRecordMs ?? nowMs;
    else if (nowMs - this.#frozenSinceMs > this.#frozenMs) this.#skipping = true;
    return {record: false, skipping: this.#skipping};
  }
}

/* ── The embedded player clock (iframe API messages) ──────────────────────── */

/** The fields of the embed's `infoDelivery` messages this module relies on. */
export type YouTubePlayerInfo = {
  currentTime?: number;
  duration?: number;
  playerState?: number;
  playbackRate?: number;
  errorCode?: number;
};

const PLAYER_INFO_KEYS = ["currentTime", "duration", "playerState", "playbackRate"] as const;

/**
 * The score clock of the captured embed. The YouTube IFrame API delivers
 * `infoDelivery` messages over postMessage (the same channel ReferenceMedia
 * already uses for seek/play commands); this class starts the handshake once,
 * keeps the latest player facts and exposes them synchronously to the capture
 * loop. Only player time is ever exposed - no wall-clock interpolation.
 */
export class YouTubePlayerClock {
  readonly #iframe: HTMLIFrameElement;
  readonly #win: Window;
  #info: YouTubePlayerInfo = {};
  #listener: ((event: MessageEvent) => void) | null = null;
  #handshakeTimer: number | null = null;
  #handshakeStartedMs = 0;
  #ready = false;
  #apiReady = false;

  constructor(iframe: HTMLIFrameElement, win: Window = window) {
    this.#iframe = iframe;
    this.#win = win;
  }

  /** Start listening and asking the embed for its player facts; safe to call twice. */
  start(): void {
    if (this.#listener) return;
    this.#listener = (event: MessageEvent) => this.#receive(event);
    this.#win.addEventListener("message", this.#listener);
    this.#handshakeStartedMs = Date.now();
    this.#sendListening();
    this.#handshakeTimer = this.#win.setInterval(() => {
      if (this.#ready || this.#handshakeStartedMs === 0 || Date.now() - this.#handshakeStartedMs > 15_000) {
        this.#clearHandshake();
        return;
      }
      this.#sendListening();
    }, 500);
  }

  stop(): void {
    if (this.#listener) this.#win.removeEventListener("message", this.#listener);
    this.#listener = null;
    this.#clearHandshake();
  }

  get ready(): boolean {
    return this.#ready;
  }

  /** True once the embed posted `onReady`: its external-method API is safe to command from then on. */
  get apiReady(): boolean {
    return this.#apiReady;
  }

  get currentTimeSec(): number | null {
    return typeof this.#info.currentTime === "number" && Number.isFinite(this.#info.currentTime) ? this.#info.currentTime : null;
  }

  get durationSec(): number | null {
    return typeof this.#info.duration === "number" && Number.isFinite(this.#info.duration) && this.#info.duration > 0 ? this.#info.duration : null;
  }

  get playerState(): number | null {
    return typeof this.#info.playerState === "number" ? this.#info.playerState : null;
  }

  get playing(): boolean {
    return this.playerState === 1;
  }

  get ended(): boolean {
    return this.playerState === 0;
  }

  get playbackRate(): number | null {
    return typeof this.#info.playbackRate === "number" ? this.#info.playbackRate : null;
  }

  get errorCode(): number | null {
    return typeof this.#info.errorCode === "number" ? this.#info.errorCode : null;
  }

  /** Post one iframe-API command (`playVideo`, `seekTo`, `setPlaybackRate`, ...). */
  command(func: string, args: unknown[] = []): void {
    this.post({event: "command", func, args});
  }

  post(payload: unknown): void {
    try {
      this.#iframe.contentWindow?.postMessage(JSON.stringify(payload), "*");
    } catch {
      // The embed navigated away or is not loaded; the caller's wait times out.
    }
  }

  /** Resolve true once the embed reported any player fact, false after `timeoutMs`. */
  async waitForInfo(timeoutMs = CAPTURE_PLAYER_READY_MS): Promise<boolean> {
    const startedAt = Date.now();
    while (!this.#ready) {
      if (Date.now() - startedAt > timeoutMs) return false;
      await sleep(100);
    }
    return true;
  }

  /**
   * Wait until the embed's external-method API answers `onReady` (and the player reports a
   * duration). Commands sent before that make the widget throw internally instead of playing,
   * so the capture must let the player finish loading first. Resolves false on timeout; the
   * caller may still try, because some embeds only send infoDelivery.
   */
  async waitForPlayerReady(timeoutMs = CAPTURE_PLAYER_READY_MS): Promise<boolean> {
    const startedAt = Date.now();
    while (!(this.#apiReady && this.#ready && this.durationSec !== null)) {
      if (Date.now() - startedAt > timeoutMs) return false;
      await sleep(100);
    }
    return true;
  }

  #sendListening(): void {
    // The embed's widget channel: asks YouTube to start sending infoDelivery/onStateChange messages.
    this.post({event: "listening", id: 1, channel: "widget"});
  }

  #clearHandshake(): void {
    if (this.#handshakeTimer !== null) {
      this.#win.clearInterval(this.#handshakeTimer);
      this.#handshakeTimer = null;
    }
  }

  #receive(event: MessageEvent): void {
    if (event.source !== this.#iframe.contentWindow) return;
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed = typeof event.data === "string" ? JSON.parse(event.data) : null;
      payload = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return;
    }
    if (!payload) return;
    const type = typeof payload.event === "string" ? payload.event : "";
    if (type === "infoDelivery" || type === "initialDelivery") {
      const info = payload.info;
      if (!info || typeof info !== "object") return;
      const next: YouTubePlayerInfo = {...this.#info};
      let changed = false;
      for (const key of PLAYER_INFO_KEYS) {
        const value = (info as Record<string, unknown>)[key];
        if (typeof value === "number" && Number.isFinite(value)) {
          next[key] = value;
          changed = true;
        }
      }
      this.#info = next;
      this.#ready = true;
      if (changed) this.#clearHandshake();
      return;
    }
    if (type === "onReady") {
      this.#ready = true;
      this.#apiReady = true;
      this.#clearHandshake();
      return;
    }
    if (type === "onStateChange") {
      const state = typeof payload.info === "number" ? payload.info : Number(payload.info);
      if (Number.isFinite(state)) this.#info = {...this.#info, playerState: state};
      return;
    }
    if (type === "onPlaybackRateChange") {
      const rate = Number(payload.info);
      if (Number.isFinite(rate)) this.#info = {...this.#info, playbackRate: rate};
      return;
    }
    if (type === "onError") {
      const code = Number(payload.info);
      if (Number.isFinite(code)) this.#info = {...this.#info, errorCode: code};
    }
  }
}

/* ── Errors, browser support, capture messages ────────────────────────────── */

export type CaptureErrorCode = "unsupported" | "denied" | "player" | "frames" | "aborted";

/** A capture-stage failure with a machine-readable kind; the poster fallback is chosen from it. */
export class CaptureError extends Error {
  readonly code: CaptureErrorCode;

  constructor(message: string, code: CaptureErrorCode) {
    super(message);
    this.name = "CaptureError";
    this.code = code;
  }
}

const isPermissionName = (name: string): boolean => name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError";

/** True when the browser refused (or never asked) for the tab: the poster draft is the fallback. */
export function isCaptureDenied(error: unknown): boolean {
  if (error instanceof CaptureError) return error.code === "denied";
  if (!error || typeof error !== "object") return false;
  const name = typeof (error as {name?: unknown}).name === "string" ? (error as {name: string}).name : "";
  // InvalidStateError = getDisplayMedia called without a user gesture; the person can click again.
  return isPermissionName(name) || name === "InvalidStateError";
}

export function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as {name?: unknown}).name === "AbortError");
}

type NavigatorLike = {mediaDevices?: {getDisplayMedia?: unknown}; userAgent?: string};

/**
 * Chromium/Edge are the only browsers that capture the current tab from a web
 * page (`preferCurrentTab`). Firefox and Safari expose getDisplayMedia but not
 * the self-tab capture this feature is built on, so they keep the poster draft.
 */
export function supportsTabCapture(nav?: NavigatorLike): boolean {
  const candidate = nav ?? (typeof navigator === "undefined" ? undefined : (navigator as NavigatorLike));
  if (!candidate?.mediaDevices || typeof candidate.mediaDevices.getDisplayMedia !== "function") return false;
  const userAgent = candidate.userAgent ?? "";
  return /(Chrome|Chromium|Edg)\//.test(userAgent) && !/OPR\//.test(userAgent);
}

export type CaptureNotice = {title: string; detail: string};

export const CAPTURE_UNSUPPORTED_NOTICE: CaptureNotice = {
  title: "Tab capture is not available in this browser",
  detail: "Showing the poster draft. Open the studio in Chrome or Edge to analyse the actual video.",
};

export const CAPTURE_DENIED_NOTICE: CaptureNotice = {
  title: "Tab capture was not allowed",
  detail: "Showing the poster draft. Choose this tab in the share dialog to analyse the actual video.",
};

/** The one line the studio shows while the player is being captured (DS rule 13: text, no bar). */
export function captureProgressText(progress: CaptureProgress): string {
  const parts: string[] = [`Capturing the player · ${Math.max(0, Math.floor(progress.playerTimeSec))} s / ${progress.durationSec > 0 ? `${Math.floor(progress.durationSec)} s` : "?"}`];
  const lastCut = progress.cuts[progress.cuts.length - 1];
  if (lastCut !== undefined) parts.push(`cut at ${lastCut.toFixed(1)} s`);
  if (progress.skipping) parts.push("Skipping ad/buffer");
  return parts.join(" · ");
}

/* ── The tab-capture engine (DOM) ─────────────────────────────────────────── */

export type CaptureEngineOptions = {
  /** The hidden <video> the captured MediaStream is attached to. */
  video: HTMLVideoElement;
  /** The embedded player iframe that is being captured. */
  iframe: HTMLIFrameElement;
  /** The player clock shared with the panel; the engine creates and owns one when absent. */
  clock?: YouTubePlayerClock;
  /** Injected for tests/fake capture; defaults to navigator.mediaDevices.getDisplayMedia. */
  getDisplayMedia?: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
  fps?: number;
  maxDurationSec?: number;
  /** Capture only this part of the video (source seconds); sample times are relative to its start. */
  section?: {startSec: number; endSec: number};
  signal?: AbortSignal;
  onProgress?: (progress: CaptureProgress) => void;
  /** Stage line for "Capturing the player (2× where possible)" right after the share is granted. */
  onStage?: (text: string) => void;
  /** Wall clock for the skip detection; defaults to Date.now. */
  now?: () => number;
  readyTimeoutMs?: number;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the capture video actually has a picture (the share was granted and attached). */
async function waitForCapturedPicture(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!(video.videoWidth > 0 && video.videoHeight > 0)) {
    if (Date.now() - startedAt > timeoutMs) throw new CaptureError("The shared tab did not deliver a picture. Share the tab again.", "frames");
    await sleep(50);
  }
}

async function waitForPlaying(clock: YouTubePlayerClock, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  let lastNudge = 0;
  while (!clock.playing) {
    if (signal?.aborted) throw new DOMException("The capture was cancelled.", "AbortError");
    const errorCode = clock.errorCode;
    if (errorCode !== null) throw playerErrorFor(errorCode);
    const now = Date.now();
    if (now - startedAt > timeoutMs) throw new CaptureError("The embedded player did not start playing. Press play in the player and try again.", "player");
    if (now - lastNudge > 1200) {
      clock.command("playVideo", []);
      lastNudge = now;
    }
    await sleep(100);
  }
}

/** A readable sentence for a YouTube player error code (the poster draft stays usable). */
function playerErrorFor(code: number): CaptureError {
  if (code === 101 || code === 150) return new CaptureError("This video does not allow embedding.", "player");
  if (code === 100) return new CaptureError("This video is not available.", "player");
  if (code === 2) return new CaptureError("The player rejected the video id.", "player");
  return new CaptureError(`The embedded player reported an error (code ${code}).`, "player");
}

const createCanvas = (width: number, height: number, frequent = false): {canvas: HTMLCanvasElement; context: CanvasRenderingContext2D} => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", frequent ? {willReadFrequently: true} : undefined);
  if (!context) throw new CaptureError("The captured tab could not be drawn for analysis.", "frames");
  return {canvas, context};
};

/** Every other stored still of the open shot is dropped once it grows past the memory bound. */
function thinOpenShotFrames(samples: CaptureSample[], shotStartSec: number): void {
  const inShot = samples.filter((sample) => sample.timeSec >= shotStartSec - 0.05);
  const framed = inShot.filter(hasFrames);
  if (framed.length <= CAPTURE_MAX_OPEN_FRAMES) return;
  const keepEvery = Math.ceil(framed.length / Math.max(1, Math.floor(CAPTURE_MAX_OPEN_FRAMES / 2)));
  framed.forEach((sample, index) => {
    if (index % keepEvery === 0) return;
    sample.frame320 = "";
    sample.still640 = "";
  });
}

/**
 * Keep only the chosen keyframe stills of a shot that just ended, so a capture
 * of a long video never holds every sampled JPEG in memory. The histograms of
 * the dropped samples stay, so the cut list and shot boundaries are unchanged.
 */
function pruneFinishedShot(samples: CaptureSample[], startSec: number, endSec: number): void {
  const inShot = samples.filter((sample) => sample.timeSec >= startSec - 0.05 && sample.timeSec < endSec);
  const picked = pickKeyframes(samples, startSec, endSec, CAPTURE_KEYFRAMES);
  const keep = new Set(picked.map((keyframe) => keyframe.timeSec));
  for (const sample of inShot) {
    if (keep.has(round3(sample.timeSec))) continue;
    sample.frame320 = "";
    sample.still640 = "";
  }
}

/**
 * Capture the embedded player in real time through getDisplayMedia (the user's
 * "Analyze reference" click is the gesture). Only player-clock timestamps are
 * recorded; the stream's tracks are always stopped before this resolves or
 * throws, so nothing of the tab keeps being shared and no video file exists.
 */
export async function captureEmbeddedPlayer(options: CaptureEngineOptions): Promise<CaptureResult> {
  const iframe = options.iframe;
  const video = options.video;
  const fps = clampNumber(Math.round(options.fps ?? CAPTURE_FPS), 1, 30);
  const intervalMs = 1000 / fps;
  const section = options.section && options.section.endSec > options.section.startSec ? options.section : undefined;
  const sectionStart = section?.startSec ?? 0;
  const maxDurationSec = Math.max(1, section ? section.endSec - section.startSec : options.maxDurationSec ?? CAPTURE_MAX_SECONDS);
  const now = options.now ?? (() => Date.now());
  const signal = options.signal;
  const ownsClock = !options.clock;
  const clock = options.clock ?? new YouTubePlayerClock(iframe);
  const getDisplayMedia = options.getDisplayMedia ?? ((constraints: DisplayMediaStreamOptions) => {
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!media || typeof media.getDisplayMedia !== "function") throw new CaptureError(CAPTURE_UNSUPPORTED_NOTICE.title, "unsupported");
    return media.getDisplayMedia(constraints);
  });
  const abortError = () => new DOMException("The capture was cancelled.", "AbortError");
  const throwIfAborted = () => {
    if (signal?.aborted) throw abortError();
  };

  let stream: MediaStream | null = null;
  let stopSharingListener: (() => void) | null = null;
  const stopStream = () => {
    if (stopSharingListener) {
      stopSharingListener();
      stopSharingListener = null;
    }
    try {
      stream?.getTracks().forEach((track) => track.stop());
    } catch {
      // A track that already ended needs no stop.
    }
    stream = null;
    try {
      video.pause();
    } catch {
      // A detached element cannot pause; nothing is playing then.
    }
    if (video.srcObject) video.srcObject = null;
  };

  try {
    throwIfAborted();
    /* The current-tab capture: the browser asks the person to share this tab once. The shape is
       Chromium's `preferCurrentTab`/`displaySurface` extension of DisplayMediaStreamOptions. */
    const constraints = {video: {displaySurface: "browser", frameRate: 30}, audio: false, preferCurrentTab: true} as unknown as DisplayMediaStreamOptions;
    try {
      stream = await getDisplayMedia(constraints);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (isCaptureDenied(error)) throw new CaptureError(CAPTURE_DENIED_NOTICE.title, "denied");
      const message = error instanceof Error && error.message ? error.message : "The tab could not be captured.";
      throw new CaptureError(message, "player");
    }
    throwIfAborted();
    /* A screen/window share cannot be mapped onto the player rectangle: the crop would sample the
       desktop. Only a tab share carries the page in CSS-pixel space; older Chromium may omit the value. */
    const sharedTrack = stream.getVideoTracks()[0];
    const sharedSurface = sharedTrack?.getSettings().displaySurface;
    if (sharedTrack && typeof sharedSurface === "string" && sharedSurface !== "browser") {
      throw new CaptureError("Choose this tab in the share dialog to capture the player.", "player");
    }
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await waitForCapturedPicture(video, 6000);
    throwIfAborted();
    await video.play().catch(() => undefined);
    /* The person stopping the share ends the capture gracefully: the samples so far stay valid. */
    const captureTrack = sharedTrack;
    try {
      iframe.scrollIntoView?.({block: "nearest", inline: "nearest"});
    } catch {
      // Scrolling the player into view is best effort; an off-screen player just records no frames.
    }
    if (options.onStage) options.onStage("Capturing the player (2× where possible)");
    clock.start();
    if (!(await clock.waitForInfo(options.readyTimeoutMs ?? CAPTURE_PLAYER_READY_MS))) {
      throw new CaptureError("The embedded player did not answer. Reload the page and try again.", "player");
    }
    /* The widget's external-method API answers onReady separately from the first info message.
       Commands sent before that make the embed throw internally and never start the video. */
    await clock.waitForPlayerReady(Math.min(6000, options.readyTimeoutMs ?? CAPTURE_PLAYER_READY_MS));
    await sleep(300);
    throwIfAborted();
    clock.command("mute");
    await sleep(120);
    // A fresh embed already sits at 0; only a player the score scrubbed (or a section) needs the seek.
    // A section starts SECTION_PREROLL_SEC early: YouTube shows its title bar for a few seconds after
    // a seek, and those frames must not become the section's stills (nothing before the start is kept).
    const seekTarget = section ? Math.max(0, sectionStart - SECTION_PREROLL_SEC) : 0;
    if (Math.abs((clock.currentTimeSec ?? 0) - seekTarget) > 0.5) {
      clock.command("seekTo", [seekTarget, true]);
      await sleep(400);
    }
    clock.command("playVideo");
    try {
      await waitForPlaying(clock, SEEK_WAIT_MS, signal);
    } catch (error) {
      if (signal?.aborted || !(error instanceof CaptureError) || error.code !== "player") throw error;
      // The widget may still have been initialising: one more nudge, no second share.
      clock.command("mute");
      clock.command("playVideo");
      await waitForPlaying(clock, 6000, signal);
    }
    clock.command("setPlaybackRate", [CAPTURE_PLAYBACK_RATE]);
    await sleep(250);
    throwIfAborted();

    const histogramCanvas = createCanvas(CAPTURE_HISTOGRAM_WIDTH, CAPTURE_HISTOGRAM_HEIGHT, true);
    const stillCanvas = createCanvas(CAPTURE_STILL_WIDTH, Math.max(16, Math.round(CAPTURE_STILL_WIDTH / DEFAULT_ASPECT_RATIO)));
    const decisionCanvas = createCanvas(CAPTURE_DECISION_WIDTH, Math.max(9, Math.round(CAPTURE_DECISION_WIDTH / DEFAULT_ASPECT_RATIO)));
    const gate = new PlayerSampleGate({frozenMs: CAPTURE_FROZEN_SKIP_MS});
    // Letterbox bars as fractions of the player height; found on the first frames, they only shrink.
    const probeCanvas = createCanvas(64, 36, true);
    let bars: {top: number; bottom: number} | null = null;
    let geometryLogged = false;
    const samples: CaptureSample[] = [];
    const cuts: number[] = [];
    const startedAt = now();
    let lastProgressAt = Number.NEGATIVE_INFINITY;
    let lastRecordedSec: number | null = null;
    let playedMs = 0;
    let skippedMs = 0;
    let shotStartSec = 0;
    let lastPlayingAt = startedAt;
    let lastAdvanceAt = startedAt;
    let timer: number | null = null;
    let settled = false;

    const reportProgress = () => {
      if (!options.onProgress) return;
      options.onProgress({
        // Section-relative, like the cuts and the samples.
        playerTimeSec: Math.max(0, (clock.currentTimeSec ?? 0) - sectionStart),
        durationSec: section ? section.endSec - section.startSec : clock.durationSec ?? 0,
        cuts: [...cuts],
        skipping: gate.skipping,
        playedSeconds: round3(playedMs / 1000),
      });
    };

    const drawSample = (playerTimeSec: number): CaptureSample | null => {
      if (!(video.videoWidth > 0) || !(video.videoHeight > 0)) return null;
      const rect = iframe.getBoundingClientRect();
      const player = captureCropRect({rect, viewport: {width: window.innerWidth, height: window.innerHeight}, capture: {width: video.videoWidth, height: video.videoHeight}});
      if (!player) return null;
      if (!geometryLogged) {
        geometryLogged = true;
        // One line per capture: the numbers behind the crop, so a misplaced crop can be explained.
        // The whole captured frame at a quarter size, with the crop drawn, for the acceptance scripts.
        try {
          const debug = createCanvas(Math.round(video.videoWidth / 4), Math.round(video.videoHeight / 4));
          debug.context.drawImage(video, 0, 0, debug.canvas.width, debug.canvas.height);
          debug.context.strokeStyle = "#ff00ff";
          debug.context.lineWidth = 2;
          debug.context.strokeRect(player.x / 4, player.y / 4, player.width / 4, player.height / 4);
          (window as unknown as {__cfCaptureFrame?: string}).__cfCaptureFrame = debug.canvas.toDataURL("image/jpeg", 0.8);
        } catch {
          // Debug evidence only.
        }
        console.info(`Capture geometry: player ${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)} in viewport ${window.innerWidth}x${window.innerHeight} (outer ${window.outerWidth}x${window.outerHeight}, dpr ${window.devicePixelRatio}); stream ${video.videoWidth}x${video.videoHeight}; crop ${player.x},${player.y} ${player.width}x${player.height}`);
      }
      probeCanvas.context.drawImage(video, player.x, player.y, player.width, player.height, 0, 0, probeCanvas.canvas.width, probeCanvas.canvas.height);
      const probe = probeCanvas.context.getImageData(0, 0, probeCanvas.canvas.width, probeCanvas.canvas.height).data;
      const rowMax: number[] = [];
      for (let y = 0; y < probeCanvas.canvas.height; y++) {
        let sum = 0;
        for (let x = 0; x < probeCanvas.canvas.width; x++) {
          const offset = (y * probeCanvas.canvas.width + x) * 4;
          sum += 0.299 * probe[offset] + 0.587 * probe[offset + 1] + 0.114 * probe[offset + 2];
        }
        rowMax.push(sum / probeCanvas.canvas.width);
      }
      const found = detectLetterbox(rowMax);
      if (found) bars = bars ? {top: Math.min(bars.top, found.top), bottom: Math.min(bars.bottom, found.bottom)} : found;
      // Only the picture: the player rectangle without the black bars of a wider film.
      const crop = bars
        ? {x: player.x, y: player.y + bars.top * player.height, width: player.width, height: player.height * (1 - bars.top - bars.bottom)}
        : player;
      const aspect = crop.width / Math.max(1, crop.height);
      const height = Math.max(16, Math.round(CAPTURE_STILL_WIDTH / clampNumber(aspect, 0.25, 4)));
      if (stillCanvas.canvas.height !== height) stillCanvas.canvas.height = height;
      const decisionHeight = Math.max(9, Math.round(CAPTURE_DECISION_WIDTH / clampNumber(aspect, 0.25, 4)));
      if (decisionCanvas.canvas.height !== decisionHeight) decisionCanvas.canvas.height = decisionHeight;
      // Draw from the shared tab onto the 640 still, then downscale it for the decision frame.
      stillCanvas.context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, stillCanvas.canvas.width, stillCanvas.canvas.height);
      decisionCanvas.context.drawImage(stillCanvas.canvas, 0, 0, stillCanvas.canvas.width, stillCanvas.canvas.height, 0, 0, decisionCanvas.canvas.width, decisionCanvas.canvas.height);
      histogramCanvas.context.drawImage(stillCanvas.canvas, 0, 0, histogramCanvas.canvas.width, histogramCanvas.canvas.height);
      const pixels = histogramCanvas.context.getImageData(0, 0, histogramCanvas.canvas.width, histogramCanvas.canvas.height).data;
      const histogram = histogramOf(pixels, histogramCanvas.canvas.width, histogramCanvas.canvas.height);
      return {
        timeSec: round3(playerTimeSec),
        histogram,
        frame320: decisionCanvas.canvas.toDataURL("image/jpeg", CAPTURE_DECISION_QUALITY),
        still640: stillCanvas.canvas.toDataURL("image/jpeg", CAPTURE_STILL_QUALITY),
        width: stillCanvas.canvas.width,
        height: stillCanvas.canvas.height,
        playerState: clock.playerState ?? 0,
      };
    };

    return await new Promise<CaptureResult>((resolve, reject) => {
      const buildResult = (): CaptureResult => {
        const knownDuration = clock.durationSec ?? 0;
        const lastTime = samples.length ? samples[samples.length - 1].timeSec : 0;
        const lastSample = samples[samples.length - 1];
        const durationSec = round3(Math.max(0.2, Math.min(maxDurationSec, Math.max(knownDuration, lastTime + 1 / fps))));
        return {
          samples,
          durationSec,
          width: lastSample?.width ?? CAPTURE_STILL_WIDTH,
          height: lastSample?.height ?? Math.max(16, Math.round(CAPTURE_STILL_WIDTH / DEFAULT_ASPECT_RATIO)),
          aspectRatio: round3((lastSample?.width ?? CAPTURE_STILL_WIDTH) / Math.max(1, lastSample?.height ?? Math.round(CAPTURE_STILL_WIDTH / DEFAULT_ASPECT_RATIO))),
          playedSeconds: round3(playedMs / 1000),
          skippedSeconds: round3(skippedMs / 1000),
          cuts: [...cuts],
        };
      };
      let onAbort: (() => void) | null = null;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        try {
          clock.command("pauseVideo");
        } catch {
          // The embed may already be gone.
        }
        if (error === undefined) resolve(buildResult());
        else reject(error);
      };
      /* A share stopped from the browser's own bar ends the capture with the samples so far. */
      if (captureTrack) {
        const onEnded = () => finish();
        captureTrack.addEventListener("ended", onEnded);
        stopSharingListener = () => captureTrack.removeEventListener("ended", onEnded);
      }
      onAbort = () => finish(abortError());
      signal?.addEventListener("abort", onAbort, {once: true});

      const tick = () => {
        if (settled) return;
        try {
          throwIfAborted();
          const playerTime = clock.currentTimeSec;
          const durationNow = clock.durationSec ?? 0;
          const reading = gate.admit(playerTime ?? Number.NaN, clock.playing, now());
          if (reading.skipping) skippedMs += intervalMs;
          // Before the section (a late seek) nothing is recorded; at its end the capture is complete.
          if (section && playerTime !== null && playerTime >= section.endSec) {
            if (samples.length) {
              finish();
              return;
            }
          }
          if (reading.record && playerTime !== null && playerTime >= sectionStart - 0.05) {
            const sample = drawSample(Math.max(0, playerTime - sectionStart));
            if (sample) {
              samples.push(sample);
              if (lastRecordedSec !== null && sample.timeSec > lastRecordedSec) playedMs += (sample.timeSec - lastRecordedSec) * 1000;
              lastRecordedSec = sample.timeSec;
              lastAdvanceAt = now();
              const previous = samples.length > 1 ? samples[samples.length - 2] : null;
              if (previous) {
                const cut = cutBetween(previous, sample, cuts.length ? cuts[cuts.length - 1] : Number.NEGATIVE_INFINITY);
                if (cut !== null) {
                  cuts.push(cut);
                  // The just-finished shot keeps only its keyframe stills; the histograms stay for the cut list.
                  pruneFinishedShot(samples, shotStartSec, cut);
                  shotStartSec = cut;
                }
              }
              thinOpenShotFrames(samples, shotStartSec);
            }
          }
          const wallNow = now();
          if (clock.playing) lastPlayingAt = wallNow;
          if (wallNow - lastProgressAt >= CAPTURE_PROGRESS_INTERVAL_MS) {
            lastProgressAt = wallNow;
            reportProgress();
          }
          const errorCode = clock.errorCode;
          if (errorCode !== null) throw playerErrorFor(errorCode);
          const observed = lastRecordedSec ?? 0;
          if (samples.length && (clock.ended || (durationNow > 0 && observed + sectionStart >= durationNow - 0.06))) {
            finish();
            return;
          }
          if (playedMs / 1000 >= maxDurationSec) {
            finish();
            return;
          }
          const sinceStart = wallNow - startedAt;
          if (!samples.length) {
            // An ad can freeze the clock for a while; only a player that never starts is a failure.
            if (sinceStart > (gate.skipping ? SKIPPING_WATCHDOG_MS : START_WATCHDOG_MS)) {
              throw new CaptureError("The embedded player did not start playing. Press play in the player and try again.", "player");
            }
          } else if (wallNow - lastPlayingAt > STALL_WATCHDOG_MS && !gate.skipping) {
            // Paused for too long (a hidden tab pauses the embed): keep what was captured.
            finish();
            return;
          } else if (wallNow - lastAdvanceAt > SKIPPING_WATCHDOG_MS) {
            // Even an ad break ends eventually; a clock that never resumes is a dead share.
            finish();
            return;
          }
          timer = window.setTimeout(tick, intervalMs);
        } catch (error) {
          finish(error);
        }
      };
      timer = window.setTimeout(tick, intervalMs);
    });
  } finally {
    stopStream();
    if (ownsClock) clock.stop();
  }
}

/* ── The analysis flow: cache first, capture second, poster as the fallback ── */

export type YoutubeAnalysisOutcome = "cache" | "captured" | "poster-draft";

export type YoutubeVideoAnalysisFlow = {
  videoId: string;
  /** Analyse only this part of the video (a link with t=); the cache keys it separately. */
  section?: {startSec: number; endSec: number};
  /** The explicit "Analyze reference" click is the only path that may ask for the tab. */
  explicit: boolean;
  signal?: AbortSignal;
  fps?: number;
  maxDurationSec?: number;
  iframe: HTMLIFrameElement;
  video: HTMLVideoElement;
  clock?: YouTubePlayerClock;
  /**
   * Ask the server for a cached analysis of this video without sending frames.
   * Returns null when the video has not been analysed yet (the server refuses a
   * first frame scan without stills) and a scan when the cache answered.
   */
  probe: (request: AnalysisFrameScanRequest) => Promise<AnalysisScan | null>;
  /** Send the captured frames; the server stores the stills and answers with a scan. */
  scanFrames: (request: AnalysisFrameScanRequest) => Promise<AnalysisScan>;
  capture: (options: CaptureEngineOptions) => Promise<CaptureResult>;
  supportsTabCapture: () => boolean;
  /** The shared decision/geometry/commit loop (same for a file scan and a capture). */
  runScan: (scan: AnalysisScan) => Promise<void>;
  /** Today's poster draft; used whenever the tab is not available or not allowed. */
  posterDraft: () => Promise<void>;
  /** The studio's one problem: exactly one of these is set per fallback. */
  notice: (notice: CaptureNotice) => void;
  stage: (text: string) => void;
  info: (text: string) => void;
  /** The player duration known so far, for the cache probe's clip facts (the cache key ignores it). */
  playerDuration: () => number | null;
  /** Called for every capture progress tick (the panel paints the provisional cuts). */
  onProgress?: (progress: CaptureProgress) => void;
};

/**
 * A cache row is usable without a capture when it has a score or when no stage
 * is missing: then the studio can paint the score and refine from the cached
 * shots, with no permission prompt and no getDisplayMedia call.
 */
export function isUsableCachedAnalysis(scan: AnalysisScan): boolean {
  if (!scan.cache?.hit) return false;
  const pending = scan.pending ?? {decisions: false, geometry: false};
  return Boolean(scan.scoreYaml?.trim()) || (!pending.decisions && !pending.geometry);
}

/**
 * Analyse a YouTube video without downloading it: probe the cache first (a
 * second analysis of the same link is a full hit with no capture), then ask for
 * the tab once, capture the embedded player, send the keyframe stills and run
 * the same decisions/geometry/commit loop as an uploaded clip. Unsupported
 * browsers, a denied share and a player that never starts keep the poster
 * draft and set exactly one Notice.
 */
export async function analyseYoutubeVideo(flow: YoutubeVideoAnalysisFlow): Promise<YoutubeAnalysisOutcome> {
  const fps = flow.fps ?? CAPTURE_FPS;
  const captureParams: AnalysisCaptureParams = {fps, keyframes: CAPTURE_KEYFRAMES, ...(flow.section ? {section: flow.section} : {})};
  const knownDuration = flow.section ? flow.section.endSec - flow.section.startSec : flow.playerDuration();
  const probeRequest: AnalysisFrameScanRequest = {
    videoId: flow.videoId,
    capture: captureParams,
    clip: {
      durationSec: Math.max(0.2, knownDuration && Number.isFinite(knownDuration) ? knownDuration : 1),
      width: CAPTURE_STILL_WIDTH,
      height: Math.max(16, Math.round(CAPTURE_STILL_WIDTH / DEFAULT_ASPECT_RATIO)),
      aspectRatio: round3(DEFAULT_ASPECT_RATIO),
    },
  };

  flow.stage("Checking the analysis cache");
  const cached = await flow.probe(probeRequest);
  if (cached && isUsableCachedAnalysis(cached)) {
    await flow.runScan(cached);
    return "cache";
  }
  const fallback = async (notice: CaptureNotice): Promise<YoutubeAnalysisOutcome> => {
    flow.notice(notice);
    await flow.posterDraft();
    return "poster-draft";
  };
  if (!flow.explicit) {
    // An automatic run has no click to grant the share, so it keeps today's poster draft.
    flow.info("Analyze reference to capture this video without downloading it.");
    await flow.posterDraft();
    return "poster-draft";
  }
  if (!flow.supportsTabCapture()) return fallback(CAPTURE_UNSUPPORTED_NOTICE);

  flow.stage("Waiting for tab capture permission");
  let result: CaptureResult;
  try {
    result = await flow.capture({
      video: flow.video,
      iframe: flow.iframe,
      clock: flow.clock,
      fps,
      maxDurationSec: flow.maxDurationSec,
      section: flow.section,
      signal: flow.signal,
      onStage: (text) => flow.stage(text),
      onProgress: (progress) => {
        flow.stage(captureProgressText(progress));
        flow.onProgress?.(progress);
      },
    });
  } catch (error) {
    if (isAbortError(error) || flow.signal?.aborted) throw error;
    console.warn("The tab capture stopped; keeping the poster draft.", error);
    if (isCaptureDenied(error)) return fallback(CAPTURE_DENIED_NOTICE);
    if (error instanceof CaptureError && error.code === "unsupported") return fallback(CAPTURE_UNSUPPORTED_NOTICE);
    const message = error instanceof Error && error.message ? error.message : "The embedded player could not be captured.";
    return fallback({title: "The YouTube player could not be captured", detail: `${message} Showing the poster draft.`});
  }
  if (flow.signal?.aborted) throw new DOMException("The capture was cancelled.", "AbortError");

  flow.stage("Reading shots");
  let request: AnalysisFrameScanRequest;
  try {
    request = framesToScanRequest(flow.videoId, result.samples, captureParams, {
      durationSec: result.durationSec,
      width: result.width,
      height: result.height,
      aspectRatio: result.aspectRatio,
    });
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "No usable frames were captured from the player.";
    return fallback({title: "No shots were read from the player", detail: `${message} Showing the poster draft.`});
  }
  const shotCount = request.shots?.length ?? 0;
  const skipped = result.skippedSeconds >= 1 ? ` Skipped ${Math.round(result.skippedSeconds)} s of ads/buffers.` : "";
  flow.info(`Captured ${shotCount} ${shotCount === 1 ? "shot" : "shots"} from ${Math.round(result.playedSeconds)} s of the player at 2× where possible.${skipped} No video file was saved.`);
  const scan = await flow.scanFrames(request);
  await flow.runScan(scan);
  return "captured";
}

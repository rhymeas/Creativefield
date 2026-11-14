/*
 * Reference analysis on the client: sample an uploaded clip, ask the server's
 * image-capable text provider for a grey-block scene plan, and turn that plan
 * into a StageFlow-style YAML score the studio can open directly.
 *
 * A YouTube link gets its poster analysed server-side (the embed exposes no
 * frames), so that plan is a draft from one frame and the duration is
 * estimated; an uploaded clip supplies real frames and its real duration.
 *
 * The pure score builder (`planToScoreYaml`, `normalizeCuts`, the plan types and
 * the measured-geometry conversion) lives in `score-build.ts`, which the team
 * server imports as well; the helpers here are re-exported so existing imports
 * of this module keep working.
 */
import type {AnalysisPlan} from "./score-build";

export type {AnalysisPlan, GeometryRejection, GeometryScoreInput, MeasuredBlockingCue, MeasuredEntity, MeasuredGeometryPlan, MeasuredShotCamera, ScorePlanOptions} from "./score-build";
export {DEFAULT_PERSON_HEIGHT_M, COLORS, measuredGeometryPlan, normalizeCuts, PERSON_HEIGHT_RANGE_M, planToScoreYaml, slug, vector, verticalFovFromLens, yamlString} from "./score-build";

export type AnalysisResult = {plan: AnalysisPlan; provider: string; model: string; frames: number};

/** Read evenly spaced frames from a clip URL, with its real duration and aspect ratio. */
export async function sampleReferenceFrames(url: string, count = 6): Promise<{frames: string[]; durationSec: number; aspectRatio: number}> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("The clip could not be read."));
    window.setTimeout(() => reject(new Error("The clip took too long to load.")), 20_000);
  });
  const duration = Math.max(0.2, Number.isFinite(video.duration) ? video.duration : 0);
  const aspectRatio = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9;
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = Math.max(2, Math.round(480 / aspectRatio));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The clip could not be drawn for analysis.");
  const frames: string[] = [];
  for (let index = 0; index < count; index++) {
    const target = Math.min(duration - 0.05, Math.max(0, (duration * (index + 0.5)) / count));
    video.currentTime = target;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      video.onseeked = done;
      window.setTimeout(done, 4000);
    });
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push(canvas.toDataURL("image/jpeg", 0.62));
  }
  return {frames, durationSec: duration, aspectRatio};
}

/** Load a clip once and report its real duration/aspect ratio. */
async function openVideo(url: string, timeoutMs = 20_000): Promise<{video: HTMLVideoElement; durationSec: number; aspectRatio: number}> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("The clip could not be read."));
    window.setTimeout(() => reject(new Error("The clip took too long to load.")), timeoutMs);
  });
  const durationSec = Math.max(0.2, Number.isFinite(video.duration) ? video.duration : 0);
  const aspectRatio = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9;
  return {video, durationSec, aspectRatio};
}

/** Seek a clip to each time and return JPEG frames at those exact timestamps. */
export async function sampleFramesAt(url: string, times: number[], width = 480): Promise<{frames: string[]; durationSec: number; aspectRatio: number}> {
  const {video, durationSec, aspectRatio} = await openVideo(url);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.max(2, Math.round(width / aspectRatio));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The clip could not be drawn for analysis.");
  const frames: string[] = [];
  for (const time of times) {
    video.currentTime = Math.min(durationSec - 0.05, Math.max(0, time));
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      video.onseeked = done;
      window.setTimeout(done, 4000);
    });
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push(canvas.toDataURL("image/jpeg", 0.62));
  }
  return {frames, durationSec, aspectRatio};
}

type HistogramSample = {time: number; histogram: number[]};

/** Distance between two normalized 3x8-bin RGB histograms, 0 (same) to 1 (unrelated). */
export function histogramDistance(left: number[], right: number[]): number {
  let sum = 0;
  const bins = Math.min(left.length, right.length);
  for (let index = 0; index < bins; index++) sum += Math.abs(left[index] - right[index]);
  return sum / 2;
}

/**
 * Turn low-resolution histogram samples into hard-cut timestamps. A cut is a
 * frame-pair distance well above the clip's own average change, so slow pans
 * and lighting changes do not register as cuts.
 */
export function cutsFromSamples(
  samples: HistogramSample[],
  options: {thresholdFactor?: number; minDistance?: number; minCutGapSec?: number} = {},
): number[] {
  if (samples.length < 2) return [];
  const distances = samples.slice(1).map((sample, index) => ({
    time: (sample.time + samples[index].time) / 2,
    distance: histogramDistance(samples[index].histogram, sample.histogram),
  }));
  const values = distances.map((entry) => entry.distance);
  // Median + MAD is robust to a clip that is mostly still with a few cuts; a mean/std
  // threshold would be inflated by those very cuts and miss them.
  const sorted = [...values].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  const deviations = values.map((value) => Math.abs(value - median)).sort((left, right) => left - right);
  const mad = deviations[Math.floor(deviations.length / 2)];
  const threshold = Math.max(options.minDistance ?? 0.18, median + (options.thresholdFactor ?? 3) * 1.4826 * Math.max(mad, 0.01));
  const minGap = options.minCutGapSec ?? 0.4;
  const cuts: number[] = [];
  for (const entry of distances) {
    if (entry.distance < threshold) continue;
    const previous = cuts[cuts.length - 1];
    if (previous !== undefined && entry.time - previous < minGap) {
      if (entry.distance > (values[distances.findIndex((candidate) => candidate.time === previous)] ?? 0)) cuts[cuts.length - 1] = entry.time;
      continue;
    }
    cuts.push(Math.round(entry.time * 100) / 100);
  }
  return cuts;
}

/** Sample a clip at a fixed rate (capped) and measure how much the image changes between samples. */
export async function sampleClipHistograms(url: string, options: {maxSamples?: number; minStepSec?: number} = {}): Promise<{durationSec: number; aspectRatio: number; samples: HistogramSample[]}> {
  const {video, durationSec, aspectRatio} = await openVideo(url);
  const maxSamples = Math.max(2, options.maxSamples ?? 200);
  const step = Math.max(options.minStepSec ?? 0.25, durationSec / maxSamples);
  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = 27;
  const context = canvas.getContext("2d", {willReadFrequently: true});
  if (!context) throw new Error("The clip could not be read for shot detection.");
  const samples: HistogramSample[] = [];
  for (let time = 0.05; time < durationSec - 0.05; time += step) {
    video.currentTime = time;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      video.onseeked = done;
      window.setTimeout(done, 3000);
    });
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const histogram = new Array(24).fill(0);
    for (let index = 0; index < pixels.length; index += 4) {
      histogram[Math.min(7, pixels[index] >> 5)] += 1;
      histogram[8 + Math.min(7, pixels[index + 1] >> 5)] += 1;
      histogram[16 + Math.min(7, pixels[index + 2] >> 5)] += 1;
    }
    const total = pixels.length / 4;
    samples.push({time, histogram: histogram.map((count) => count / total)});
  }
  return {durationSec, aspectRatio, samples};
}

/** Real shot boundaries from an uploaded clip: frame-change analysis, no model needed. */
export async function detectShotCuts(url: string): Promise<{durationSec: number; aspectRatio: number; cuts: number[]; shots: Array<{start: number; end: number}>}> {
  const {durationSec, aspectRatio, samples} = await sampleClipHistograms(url);
  const cuts = cutsFromSamples(samples)
    .filter((cut) => cut > 0.4 && cut < durationSec - 0.4)
    .slice(0, 11);
  const bounds = [0, ...cuts, durationSec];
  const shots = bounds.slice(1).map((end, index) => ({start: bounds[index], end}));
  return {durationSec, aspectRatio, cuts, shots};
}

/**
 * Server-side cut detection with FFmpeg scdet, which reads actual frame changes
 * and is much more reliable than the browser histogram fallback. The clip is
 * uploaded for the scan and deleted afterwards.
 */
export async function detectShotCutsOnServer(workspaceId: string, blob: Blob, name = "reference.mp4"): Promise<{durationSec: number; aspectRatio: number; cuts: number[]; shots: Array<{start: number; end: number}>}> {
  if (!blob.size) throw new Error("The clip could not be read.");
  const form = new FormData();
  form.append("file", blob.type ? blob : new File([blob], name, {type: "video/mp4"}), name);
  const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/reference-shots`, {
    method: "POST",
    body: form,
    credentials: "same-origin",
    signal: AbortSignal.timeout(180_000),
  });
  const body = (await response.json().catch(() => null)) as
    | {durationSec?: number; aspectRatio?: number; cuts?: number[]; shots?: Array<{start: number; end: number}>; error?: string}
    | null;
  if (!response.ok || !body || !Array.isArray(body.cuts) || !body.durationSec) {
    throw new Error(body?.error ?? `Shot detection failed (${response.status}).`);
  }
  return {
    durationSec: body.durationSec,
    aspectRatio: body.aspectRatio ?? 16 / 9,
    cuts: body.cuts,
    shots: body.shots ?? [],
  };
}

/** Ask the server to read the reference and return a scene plan. */
export async function requestReferenceAnalysis(input: {
  workspaceId: string;
  videoId?: string;
  frames?: string[];
  durationSec?: number;
  aspectRatio?: number;
  cuts?: number[];
  shotIndices?: number[];
  note?: string;
}): Promise<AnalysisResult> {
  const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}/reference-analysis`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    credentials: "same-origin",
    body: JSON.stringify({
      ...(input.videoId ? {videoId: input.videoId} : {}),
      ...(input.frames?.length ? {frames: input.frames} : {}),
      ...(input.durationSec ? {durationSec: input.durationSec} : {}),
      ...(input.aspectRatio ? {aspectRatio: input.aspectRatio} : {}),
      ...(input.cuts?.length ? {cuts: input.cuts} : {}),
      ...(input.shotIndices?.length ? {shotIndices: input.shotIndices} : {}),
      ...(input.note ? {note: input.note} : {}),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = (await response.json().catch(() => null)) as (AnalysisResult & {error?: string}) | null;
  if (!response.ok || !body || !body.plan) throw new Error(body?.error ?? `Analysis failed (${response.status}).`);
  return body;
}


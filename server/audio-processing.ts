import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { DiskStore } from "./storage";
import {
  AUDIO_MAX_AUDIO_DURATION_SECONDS,
  AUDIO_MAX_CHANNELS,
  AUDIO_MAX_VIDEO_DURATION_SECONDS,
  AUDIO_OUTPUT_SAMPLE_RATE,
  AUDIO_TIMING_TOLERANCE_SECONDS,
  audioOutputKind,
  type AudioMeasurement,
  type AudioOperationRequest,
  type LongAudioPolicy,
  type ShortAudioPolicy,
} from "./audio-policy";
import {
  AudioProcessingAbortedError,
  AudioProcessingError,
  audioToolVersions,
  ffmpegPath,
  probeMedia,
  runTool,
  streamDuration,
  streamsOfType,
  validateAudioOutput,
  videoFrameTiming,
  type MediaInfo,
  type MediaStream,
  type VideoTiming,
} from "./audio-processing-validation";

export { AudioProcessingAbortedError, AudioProcessingError, AudioToolUnavailableError } from "./audio-processing-validation";

function formatSeconds(value: number): string {
  return String(Number(value.toFixed(6)));
}

/**
 * Decide how a track ending at `endOnTimelineSeconds` fits the fixed video
 * timeline. Only the declared policies may pad or trim; reject means reject.
 */
export function planTimelineFit(options: {
  videoDurationSeconds: number;
  endOnTimelineSeconds: number;
  shortAudio: ShortAudioPolicy;
  longAudio: LongAudioPolicy;
  track: string;
}): "exact" | "pad_silence" | "trim" {
  const delta = options.endOnTimelineSeconds - options.videoDurationSeconds;
  if (Math.abs(delta) <= AUDIO_TIMING_TOLERANCE_SECONDS) return "exact";
  if (delta < 0) {
    if (options.shortAudio === "reject") {
      throw new AudioProcessingError(`${options.track} ends ${formatSeconds(-delta)}s before the video ends and shortAudio is reject; no silence was added`);
    }
    return "pad_silence";
  }
  if (options.longAudio === "reject") {
    throw new AudioProcessingError(`${options.track} runs ${formatSeconds(delta)}s past the video end and longAudio is reject; nothing was trimmed`);
  }
  return "trim";
}

type AudioChainOptions = {
  label: string;
  startSeconds: number;
  endSeconds?: number;
  offsetSeconds: number;
  gainDb: number;
  videoDurationSeconds: number;
  stereo: boolean;
};

function audioChain(input: string, options: AudioChainOptions): string {
  const parts: string[] = [];
  if (options.startSeconds > 0 || options.endSeconds !== undefined) {
    parts.push(`atrim=start=${formatSeconds(options.startSeconds)}${options.endSeconds !== undefined ? `:end=${formatSeconds(options.endSeconds)}` : ""}`, "asetpts=PTS-STARTPTS");
  }
  if (options.offsetSeconds > 0) parts.push(`adelay=delays=${Math.round(options.offsetSeconds * 1000)}:all=1`);
  if (options.gainDb !== 0) parts.push(`volume=volume=${formatSeconds(options.gainDb)}dB`);
  parts.push(options.stereo ? `aresample=${AUDIO_OUTPUT_SAMPLE_RATE}:out_chlayout=stereo` : `aresample=${AUDIO_OUTPUT_SAMPLE_RATE}`);
  // The caller has already enforced the declared short/long policy with
  // planTimelineFit; apad+atrim only conform the accepted track to the exact
  // fixed video duration.
  parts.push("apad", `atrim=duration=${formatSeconds(options.videoDurationSeconds)}`, "asetpts=N/SR/TB");
  return `${input}${parts.join(",")}[${options.label}]`;
}

/** Pure FFmpeg argument construction so stream maps are unit-testable. */
export function buildAudioFfmpegArgs(options: {
  request: AudioOperationRequest;
  videoFile: string;
  audioFile?: string;
  outputFile: string;
  videoDurationSeconds: number;
  expectedAudioChannels: number | null;
  maxBytes: number;
}): string[] {
  const { request } = options;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
  const videoInput = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-i", options.videoFile];
  const audioInput = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "wav,mp3,flac,ogg,mov,matroska,webm", "-i", options.audioFile ?? ""];
  const limit = ["-fs", String(options.maxBytes + 1)];
  if (request.operation === "extract") {
    return [...args, ...videoInput, "-map", `0:a:${request.sourceAudioStreamIndex}`, "-vn", "-c:a", "pcm_s16le", "-map_metadata", "-1", ...limit, options.outputFile];
  }
  if (request.operation === "mute") {
    return [...args, ...videoInput, "-map", `0:v:${request.videoStreamIndex}`, "-c:v", "copy", "-an", "-map_metadata", "-1", "-movflags", "+faststart", ...limit, options.outputFile];
  }
  const external = () => audioChain(`[1:a:${request.audioStreamIndex}]`, {
    label: request.operation === "mix" ? "x" : "a",
    startSeconds: request.audioStartSeconds,
    endSeconds: request.audioEndSeconds,
    offsetSeconds: request.offsetSeconds,
    gainDb: request.audioGainDb,
    videoDurationSeconds: options.videoDurationSeconds,
    stereo: request.operation === "mix",
  });
  const source = (label: string) => audioChain(`[0:a:${request.sourceAudioStreamIndex}]`, {
    label,
    startSeconds: 0,
    offsetSeconds: 0,
    gainDb: request.sourceGainDb,
    videoDurationSeconds: options.videoDurationSeconds,
    stereo: request.operation === "mix",
  });
  let filter: string;
  if (request.operation === "preserve") filter = source("a");
  else if (request.operation === "replace") filter = external();
  else filter = `${source("s")};${external()};[s][x]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`;
  return [
    ...args, ...videoInput, ...(request.operation === "preserve" ? [] : audioInput),
    "-filter_complex_threads", "1", "-filter_complex", filter,
    "-map", `0:v:${request.videoStreamIndex}`, "-map", "[a]",
    "-c:v", "copy", "-c:a", "aac", "-ar", String(AUDIO_OUTPUT_SAMPLE_RATE), "-ac", String(options.expectedAudioChannels ?? 2),
    "-map_metadata", "-1", "-movflags", "+faststart", ...limit, options.outputFile,
  ];
}

export type AudioInputContext = {
  videoInfo: MediaInfo;
  videoDurationSeconds: number;
  videoTiming: VideoTiming | null;
  sourceAudioStream: MediaStream | null;
  sourceAudioDurationSeconds: number | null;
  expectedAudioChannels: number | null;
};

function assertUsableAudioStream(stream: MediaStream, description: string): void {
  if (!stream.channels || stream.channels < 1 || stream.channels > AUDIO_MAX_CHANNELS || !stream.sampleRate || stream.sampleRate <= 0) {
    throw new AudioProcessingError(`${description} must be mono or stereo audio with a valid sample rate`);
  }
}

/**
 * Probe pinned inputs and enforce stream, codec and duration policy before
 * any processing or candidate reuse. Missing source audio is an error, never
 * an invitation to synthesize silence.
 */
export async function inspectAudioInputs(options: {
  request: AudioOperationRequest;
  videoFile: string;
  audioFile?: string;
  signal?: AbortSignal;
}): Promise<AudioInputContext> {
  const { request } = options;
  const videoInfo = await probeMedia(options.videoFile, "video", options.signal);
  const videos = streamsOfType(videoInfo, "video");
  const video = videos[request.videoStreamIndex];
  if (!video) throw new AudioProcessingError(`Video stream ${request.videoStreamIndex} does not exist in the pinned video asset`);
  const videoDurationSeconds = streamDuration(video, videoInfo);
  if (videoDurationSeconds > AUDIO_MAX_VIDEO_DURATION_SECONDS) {
    throw new AudioProcessingError(`Video exceeds the ${AUDIO_MAX_VIDEO_DURATION_SECONDS}s audio-policy limit`);
  }
  if (request.operation !== "extract") {
    if (video.codecName !== "h264") {
      throw new AudioProcessingError("Only H.264 video can be muxed without transcoding in this contract; the video was not transcoded");
    }
    if (video.startTime !== undefined && Math.abs(video.startTime) > AUDIO_TIMING_TOLERANCE_SECONDS) {
      throw new AudioProcessingError("Video stream does not start at timestamp zero; bake timestamps before audio muxing");
    }
  }
  const sourceAudios = streamsOfType(videoInfo, "audio");
  let sourceAudioStream: MediaStream | null = null;
  let sourceAudioDurationSeconds: number | null = null;
  if (request.sourceAudioStreamIndex !== undefined) {
    sourceAudioStream = sourceAudios[request.sourceAudioStreamIndex] ?? null;
    if (!sourceAudioStream) {
      throw new AudioProcessingError(`Source audio stream ${request.sourceAudioStreamIndex} is missing from the pinned video asset; silence is not synthesized`);
    }
    assertUsableAudioStream(sourceAudioStream, "Source audio");
    if (sourceAudioStream.startTime !== undefined && Math.abs(sourceAudioStream.startTime) > AUDIO_TIMING_TOLERANCE_SECONDS) {
      throw new AudioProcessingError("Source audio does not start at timestamp zero; preserve or mix would shift its synchronization");
    }
    sourceAudioDurationSeconds = streamDuration(sourceAudioStream, videoInfo);
  }
  let expectedAudioChannels: number | null = null;
  if (request.operation === "preserve") {
    planTimelineFit({
      videoDurationSeconds,
      endOnTimelineSeconds: sourceAudioDurationSeconds ?? 0,
      shortAudio: request.shortAudio!, longAudio: request.longAudio!, track: "Source audio",
    });
    expectedAudioChannels = sourceAudioStream?.channels ?? null;
  }
  if (request.operation === "replace" || request.operation === "mix") {
    if (!options.audioFile) throw new AudioProcessingError("The pinned audio asset file is unavailable");
    const audioInfo = await probeMedia(options.audioFile, "audio", options.signal);
    if (audioInfo.durationSeconds > AUDIO_MAX_AUDIO_DURATION_SECONDS) {
      throw new AudioProcessingError(`Audio exceeds the ${AUDIO_MAX_AUDIO_DURATION_SECONDS}s audio-policy limit`);
    }
    const external = streamsOfType(audioInfo, "audio")[request.audioStreamIndex ?? 0];
    if (!external) throw new AudioProcessingError(`Audio stream ${request.audioStreamIndex} does not exist in the pinned audio asset`);
    assertUsableAudioStream(external, "External audio");
    const externalDuration = streamDuration(external, audioInfo);
    if (request.audioStartSeconds >= externalDuration) {
      throw new AudioProcessingError("audioStartSeconds is beyond the end of the pinned audio asset");
    }
    if (request.offsetSeconds >= videoDurationSeconds) {
      throw new AudioProcessingError("offsetSeconds must place external audio before the fixed video timeline ends");
    }
    const effectiveEnd = Math.min(request.audioEndSeconds ?? externalDuration, externalDuration);
    planTimelineFit({
      videoDurationSeconds,
      endOnTimelineSeconds: request.offsetSeconds + (effectiveEnd - request.audioStartSeconds),
      shortAudio: request.shortAudio!, longAudio: request.longAudio!, track: "External audio",
    });
    if (request.operation === "mix") {
      planTimelineFit({
        videoDurationSeconds,
        endOnTimelineSeconds: sourceAudioDurationSeconds ?? 0,
        shortAudio: request.shortAudio!, longAudio: request.longAudio!, track: "Source audio",
      });
      expectedAudioChannels = 2;
    } else {
      expectedAudioChannels = external.channels ?? null;
    }
  }
  const videoTiming = request.operation === "extract"
    ? null
    : await videoFrameTiming(options.videoFile, request.videoStreamIndex, options.signal);
  return { videoInfo, videoDurationSeconds, videoTiming, sourceAudioStream, sourceAudioDurationSeconds, expectedAudioChannels };
}

export type AudioValidationSummary = {
  outputDurationSeconds: number;
  videoDurationSeconds: number;
  videoTimingDigest: string | null;
  videoFrames: number | null;
  measurement: AudioMeasurement | null;
  tools: { ffmpeg: string; ffprobe: string };
};

async function summarize(context: AudioInputContext, request: AudioOperationRequest, outputFile: string, signal?: AbortSignal): Promise<AudioValidationSummary> {
  const validated = await validateAudioOutput({
    request,
    outputFile,
    videoInfo: context.videoInfo,
    videoDurationSeconds: context.videoDurationSeconds,
    // Extract has no muxed video to compare; validateAudioOutput ignores timing there.
    videoTiming: context.videoTiming ?? { frames: 0, timingDigest: "0".repeat(64), width: 0, height: 0 },
    expectedAudioChannels: context.expectedAudioChannels,
    sourceAudioDurationSeconds: context.sourceAudioDurationSeconds,
    sourceAudioStream: context.sourceAudioStream,
    signal,
  });
  return {
    outputDurationSeconds: validated.info.durationSeconds,
    videoDurationSeconds: context.videoDurationSeconds,
    videoTimingDigest: validated.timing?.timingDigest ?? null,
    videoFrames: validated.timing?.frames ?? null,
    measurement: validated.measurement,
    tools: await audioToolVersions(),
  };
}

/** Revalidate a persisted stage candidate before reusing it after a restart. */
export async function revalidateAudioCandidate(options: {
  request: AudioOperationRequest;
  videoFile: string;
  audioFile?: string;
  candidateFile: string;
  signal?: AbortSignal;
}): Promise<AudioValidationSummary> {
  const context = await inspectAudioInputs(options);
  return summarize(context, options.request, options.candidateFile, options.signal);
}

export type ProcessedAudioCandidate = AudioValidationSummary & {
  key: string;
  sha256: string;
  bytes: number;
};

/**
 * Run one deterministic local stage: probe, process in private scratch under
 * the storage root, validate, then store an unpublished candidate. The
 * caller owns publication; on any failure scratch and candidate are removed.
 */
export async function processAudioOperation(options: {
  store: DiskStore;
  workspaceId: string;
  request: AudioOperationRequest;
  videoFile: string;
  audioFile?: string;
  signal: AbortSignal;
}): Promise<ProcessedAudioCandidate> {
  const { store, workspaceId, request, signal } = options;
  const context = await inspectAudioInputs({ request, videoFile: options.videoFile, audioFile: options.audioFile, signal });
  const root = path.join(store.root, ".audio-processing");
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw new AudioProcessingError("Invalid audio scratch directory");
  const resolved = await realpath(root);
  const dir = await mkdtemp(path.join(resolved, "attempt-"));
  const outputFile = path.join(dir, `output.${audioOutputKind(request.operation).extension}`);
  let candidate: { key: string; sha256: string; bytes: number } | undefined;
  try {
    signal.throwIfAborted();
    const args = buildAudioFfmpegArgs({
      request,
      videoFile: options.videoFile,
      audioFile: options.audioFile,
      outputFile,
      videoDurationSeconds: context.videoDurationSeconds,
      expectedAudioChannels: context.expectedAudioChannels,
      maxBytes: store.maxBytes,
    });
    await runTool(ffmpegPath(), args, signal, 300000);
    if ((await stat(outputFile)).size > store.maxBytes) throw new AudioProcessingError("Audio output exceeds the configured media limit");
    const summary = await summarize(context, request, outputFile, signal);
    signal.throwIfAborted();
    candidate = await store.put(workspaceId, createReadStream(outputFile));
    return { ...candidate, ...summary };
  } catch (error) {
    if (candidate) await store.remove(workspaceId, candidate.key).catch(() => {});
    if (signal.aborted && !(error instanceof AudioProcessingAbortedError)) throw new AudioProcessingAbortedError("Audio processing was interrupted");
    throw error;
  } finally {
    if (path.dirname(await realpath(dir).catch(() => dir)) === resolved) {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (entry.isFile()) await unlink(path.join(dir, entry.name)).catch(() => {});
      }
      await rmdir(dir).catch(() => {});
    }
  }
}

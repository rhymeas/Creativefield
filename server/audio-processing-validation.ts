import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  AUDIO_MAX_AUDIO_DURATION_SECONDS,
  AUDIO_MAX_VIDEO_DURATION_SECONDS,
  AUDIO_OUTPUT_SAMPLE_RATE,
  AUDIO_TIMING_TOLERANCE_SECONDS,
  type AudioMeasurement,
  type AudioOperationRequest,
} from "./audio-policy";

const execute = promisify(execFile);

/** Permanent failure: the media or request cannot satisfy the declared policy. */
export class AudioProcessingError extends Error {}
/** Transient failure: FFmpeg/FFprobe is unavailable or timed out; retry may succeed. */
export class AudioToolUnavailableError extends Error {}
/** The caller's abort signal fired (cancellation or shutdown). */
export class AudioProcessingAbortedError extends Error {}

export function ffmpegPath(): string { return process.env.FFMPEG_PATH ?? "ffmpeg"; }
export function ffprobePath(): string { return process.env.FFPROBE_PATH ?? "ffprobe"; }

export async function runTool(command: string, args: string[], signal?: AbortSignal, timeoutMs = 120000): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execute(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error) {
    if (signal?.aborted) throw new AudioProcessingAbortedError("Audio processing was interrupted");
    const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; stderr?: string };
    if (e.code === "ENOENT" || e.code === "EACCES" || e.killed) {
      throw new AudioToolUnavailableError("FFmpeg/FFprobe is temporarily unavailable");
    }
    throw new AudioProcessingError("Media tool rejected the input or output as invalid");
  }
}

export type MediaStream = {
  index: number;
  codecType: string;
  codecName?: string;
  channels?: number;
  sampleRate?: number;
  width?: number;
  height?: number;
  startTime?: number;
  duration?: number;
};
export type MediaInfo = {
  container?: string;
  durationSeconds: number;
  streams: MediaStream[];
};

export function streamsOfType(info: MediaInfo, type: "video" | "audio"): MediaStream[] {
  return info.streams.filter(stream => stream.codecType === type);
}
export function streamDuration(stream: MediaStream, info: MediaInfo): number {
  return stream.duration !== undefined && Number.isFinite(stream.duration) && stream.duration > 0 ? stream.duration : info.durationSeconds;
}

const FORMAT_WHITELIST = {
  video: "mov,matroska,webm",
  audio: "wav,mp3,flac,ogg,mov,matroska,webm",
} as const;

/** Bounded structural probe. Playlists and nested file reads stay disabled. */
export async function probeMedia(file: string, kind: keyof typeof FORMAT_WHITELIST, signal?: AbortSignal): Promise<MediaInfo> {
  const { stdout } = await runTool(ffprobePath(), [
    "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", FORMAT_WHITELIST[kind],
    "-max_alloc", "67108864", "-threads", "1", "-show_streams", "-show_format", "-of", "json", file,
  ], signal, 30000);
  let data: { streams?: Array<Record<string, unknown>>; format?: { duration?: string; format_name?: string } };
  try { data = JSON.parse(stdout); } catch { throw new AudioProcessingError("Media probe returned invalid data"); }
  const durationSeconds = Number(data.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new AudioProcessingError("Media has no valid duration");
  const streams: MediaStream[] = (data.streams ?? []).map(raw => ({
    index: Number(raw.index),
    codecType: String(raw.codec_type ?? ""),
    codecName: raw.codec_name === undefined ? undefined : String(raw.codec_name),
    channels: raw.channels === undefined ? undefined : Number(raw.channels),
    sampleRate: raw.sample_rate === undefined ? undefined : Number(raw.sample_rate),
    width: raw.width === undefined ? undefined : Number(raw.width),
    height: raw.height === undefined ? undefined : Number(raw.height),
    startTime: raw.start_time === undefined ? undefined : Number(raw.start_time),
    duration: raw.duration === undefined ? undefined : Number(raw.duration),
  }));
  if (!streams.length) throw new AudioProcessingError("Media contains no streams");
  return { container: data.format?.format_name, durationSeconds, streams };
}

export type VideoTiming = { frames: number; timingDigest: string; width: number; height: number };

/** Decoded frame timestamps prove muxing copied frames and timing unchanged. */
export async function videoFrameTiming(file: string, videoStreamIndex: number, signal?: AbortSignal): Promise<VideoTiming> {
  const { stdout } = await runTool(ffprobePath(), [
    "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", FORMAT_WHITELIST.video,
    "-max_alloc", "67108864", "-threads", "1",
    "-select_streams", `v:${videoStreamIndex}`, "-show_frames",
    "-show_entries", "frame=best_effort_timestamp_time,width,height", "-of", "json", file,
  ], signal, 120000);
  let data: { frames?: Array<{ best_effort_timestamp_time?: string; width?: number; height?: number }> };
  try { data = JSON.parse(stdout); } catch { throw new AudioProcessingError("Frame probe returned invalid data"); }
  const frames = data.frames ?? [];
  if (!frames.length) throw new AudioProcessingError("Video contains no decoded frames");
  const width = Number(frames[0].width), height = Number(frames[0].height);
  const pts = frames.map(frame => {
    const t = Number(frame.best_effort_timestamp_time);
    if (!Number.isFinite(t) || Number(frame.width) !== width || Number(frame.height) !== height) {
      throw new AudioProcessingError("Decoded video frames have inconsistent timing or dimensions");
    }
    return Math.round(t * 1e6);
  });
  return { frames: frames.length, timingDigest: createHash("sha256").update(JSON.stringify(pts)).digest("hex"), width, height };
}

function loudnessValue(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Integrated loudness and true peak via FFmpeg's loudnorm measurement.
 * Silence is an explicit outcome: integrated LUFS stays null, never finite.
 */
export async function measureLoudness(file: string, audioStreamIndex: number, kind: keyof typeof FORMAT_WHITELIST, signal?: AbortSignal): Promise<AudioMeasurement> {
  const { stderr } = await runTool(ffmpegPath(), [
    "-hide_banner", "-nostdin", "-v", "info",
    "-protocol_whitelist", "file,pipe", "-format_whitelist", FORMAT_WHITELIST[kind],
    "-i", file, "-map", `0:a:${audioStreamIndex}`,
    "-af", "loudnorm=I=-23:TP=-2:LRA=11:print_format=json",
    "-f", "null", "-",
  ], signal, 180000);
  const match = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/s);
  if (!match) throw new AudioProcessingError("Loudness measurement did not report results");
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(match[0]); } catch { throw new AudioProcessingError("Loudness measurement returned invalid data"); }
  const integratedLufs = loudnessValue(parsed.input_i);
  return {
    integratedLufs,
    truePeakDb: loudnessValue(parsed.input_tp),
    loudnessRangeLu: loudnessValue(parsed.input_lra),
    silence: integratedLufs === null,
  };
}

export type ValidatedAudioOutput = {
  info: MediaInfo;
  timing: VideoTiming | null;
  measurement: AudioMeasurement | null;
};

/**
 * Validate a finished candidate against the fixed video timeline and the
 * declared output contract. `expectedAudioChannels` is decided by the
 * operation (source channels, external channels, or stereo for mix).
 */
export async function validateAudioOutput(options: {
  request: AudioOperationRequest;
  outputFile: string;
  videoInfo: MediaInfo;
  videoDurationSeconds: number;
  videoTiming: VideoTiming;
  expectedAudioChannels: number | null;
  sourceAudioDurationSeconds: number | null;
  sourceAudioStream: MediaStream | null;
  signal?: AbortSignal;
}): Promise<ValidatedAudioOutput> {
  const { request } = options;
  const within = (a: number, b: number) => Math.abs(a - b) <= AUDIO_TIMING_TOLERANCE_SECONDS;
  if (request.operation === "extract") {
    const info = await probeMedia(options.outputFile, "audio", options.signal);
    const audios = streamsOfType(info, "audio");
    if (!info.container?.includes("wav") || audios.length !== 1 || streamsOfType(info, "video").length !== 0) {
      throw new AudioProcessingError("Extracted output is not a single-stream WAV audio file");
    }
    const source = options.sourceAudioStream;
    if (!source || audios[0].channels !== source.channels || audios[0].sampleRate !== source.sampleRate) {
      throw new AudioProcessingError("Extracted audio does not preserve the source channel and sample-rate contract");
    }
    if (options.sourceAudioDurationSeconds === null || !within(info.durationSeconds, options.sourceAudioDurationSeconds)) {
      throw new AudioProcessingError("Extracted audio duration does not match the selected source stream");
    }
    const measurement = await measureLoudness(options.outputFile, 0, "audio", options.signal);
    return { info, timing: null, measurement };
  }
  const info = await probeMedia(options.outputFile, "video", options.signal);
  const videos = streamsOfType(info, "video"), audios = streamsOfType(info, "audio");
  if (!info.container?.includes("mp4") && !info.container?.includes("mov")) {
    throw new AudioProcessingError("Muxed output is not an MP4-family container");
  }
  if (videos.length !== 1 || videos[0].codecName !== "h264") {
    throw new AudioProcessingError("Muxed output must contain exactly the copied H.264 video stream");
  }
  if (!within(info.durationSeconds, options.videoDurationSeconds)) {
    throw new AudioProcessingError("Muxed output duration does not match the fixed video timeline");
  }
  const timing = await videoFrameTiming(options.outputFile, 0, options.signal);
  if (timing.timingDigest !== options.videoTiming.timingDigest || timing.frames !== options.videoTiming.frames) {
    throw new AudioProcessingError("Muxed output video frames or timestamps differ from the source video");
  }
  if (request.operation === "mute") {
    if (audios.length !== 0) throw new AudioProcessingError("Mute output must not contain an audio stream");
    return { info, timing, measurement: null };
  }
  if (audios.length !== 1) throw new AudioProcessingError("Muxed output must contain exactly one audio stream");
  const audio = audios[0];
  if (audio.sampleRate !== AUDIO_OUTPUT_SAMPLE_RATE || audio.channels !== options.expectedAudioChannels) {
    throw new AudioProcessingError("Muxed output audio does not match the declared channel and sample-rate contract");
  }
  if (audio.startTime !== undefined && Math.abs(audio.startTime) > AUDIO_TIMING_TOLERANCE_SECONDS) {
    throw new AudioProcessingError("Muxed output audio does not start on the video timeline");
  }
  if (!within(streamDuration(audio, info), options.videoDurationSeconds)) {
    throw new AudioProcessingError("Muxed output audio does not span the fixed video timeline");
  }
  const measurement = await measureLoudness(options.outputFile, 0, "video", options.signal);
  return { info, timing, measurement };
}

async function toolVersion(command: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await runTool(command, ["-version"], undefined, 5000);
    return (stdout || stderr).split(/\r?\n/)[0]?.trim() || undefined;
  } catch { return undefined; }
}

export async function audioToolVersions(): Promise<{ ffmpeg: string; ffprobe: string }> {
  const ffmpeg = await toolVersion(ffmpegPath()), ffprobe = await toolVersion(ffprobePath());
  if (!ffmpeg || !ffprobe) throw new AudioToolUnavailableError("FFmpeg/FFprobe is temporarily unavailable");
  return { ffmpeg, ffprobe };
}

const REQUIRED_ENCODERS = ["aac", "pcm_s16le"];
const REQUIRED_FILTERS = ["loudnorm", "apad", "atrim", "adelay", "amix", "volume", "aresample", "asetpts"];

/** Readiness verifies the actual encoders and filters this contract uses. */
export async function audioReadiness() {
  const missing: string[] = [];
  const ffmpeg = await toolVersion(ffmpegPath()), ffprobe = await toolVersion(ffprobePath());
  if (!ffmpeg) missing.push("FFmpeg");
  if (!ffprobe) missing.push("FFprobe");
  if (ffmpeg) {
    try {
      const encoders = await runTool(ffmpegPath(), ["-hide_banner", "-encoders"], undefined, 5000);
      for (const encoder of REQUIRED_ENCODERS) {
        if (!new RegExp(`\\b${encoder}\\b`).test(encoders.stdout)) missing.push(`FFmpeg encoder ${encoder}`);
      }
      const filters = await runTool(ffmpegPath(), ["-hide_banner", "-filters"], undefined, 5000);
      for (const filter of REQUIRED_FILTERS) {
        if (!new RegExp(`\\s${filter}\\s`).test(filters.stdout)) missing.push(`FFmpeg filter ${filter}`);
      }
    } catch { missing.push("FFmpeg encoder/filter inventory"); }
  }
  return {
    state: missing.length ? "install_required" : "ready",
    missing,
    versions: { ffmpeg: ffmpeg ?? null, ffprobe: ffprobe ?? null },
    instructions: "Install FFmpeg and FFprobe on the team server, or set FFMPEG_PATH and FFPROBE_PATH to their executables. The build must include the aac and pcm_s16le encoders and the loudnorm, apad, atrim, adelay, amix, volume, aresample and asetpts filters.",
    storage: "Scratch and media use the configured storage root; scratch stays private under it and is removed after each attempt.",
    limits: {
      maxVideoDurationSeconds: AUDIO_MAX_VIDEO_DURATION_SECONDS,
      maxAudioDurationSeconds: AUDIO_MAX_AUDIO_DURATION_SECONDS,
      timingToleranceSeconds: AUDIO_TIMING_TOLERANCE_SECONDS,
      outputSampleRate: AUDIO_OUTPUT_SAMPLE_RATE,
      loudness: "measure_only",
      soundGeneration: "planned",
    },
  };
}

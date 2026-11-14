import { z } from "zod";

/**
 * VID-06 typed audio-policy contract for durable project video assets.
 *
 * The video timeline is fixed. Every operation names its streams explicitly,
 * pins its inputs by SHA-256, and declares what happens when audio is shorter
 * or longer than the video. There is no time-stretching, no looping, no
 * implicit silence for a missing source track, and no route substitution.
 * Loudness is measured on every output; normalization is not implemented in
 * this contract version, so the only accepted loudness mode is measurement.
 */

export const AUDIO_POLICY_VERSION = 1;
/** Output audio for mux operations is resampled to this rate. */
export const AUDIO_OUTPUT_SAMPLE_RATE = 48000;
/** Mono and stereo inputs only in this bounded contract. */
export const AUDIO_MAX_CHANNELS = 2;
export const AUDIO_MAX_VIDEO_DURATION_SECONDS = 600;
export const AUDIO_MAX_AUDIO_DURATION_SECONDS = 3600;
/**
 * Container/encoder priming tolerance. Duration differences within this bound
 * are conformed to the exact video duration; larger differences follow the
 * explicit short/long policy declared in the request.
 */
export const AUDIO_TIMING_TOLERANCE_SECONDS = 0.12;
export const AUDIO_MAX_ATTEMPTS = 3;

const digest = z.string().regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 hex digest");
const streamIndex = z.number().int().min(0).max(15);
const gainDb = z.number().finite().min(-60).max(24);
const seconds = z.number().finite().min(0).max(AUDIO_MAX_AUDIO_DURATION_SECONDS);

export const audioOperationKindSchema = z.enum(["extract", "preserve", "mute", "replace", "mix"]);
export type AudioOperationKind = z.infer<typeof audioOperationKindSchema>;
export const shortAudioPolicySchema = z.enum(["reject", "pad_silence"]);
export type ShortAudioPolicy = z.infer<typeof shortAudioPolicySchema>;
export const longAudioPolicySchema = z.enum(["reject", "trim"]);
export type LongAudioPolicy = z.infer<typeof longAudioPolicySchema>;

export const audioOperationRequestSchema = z.object({
  projectId: z.uuid(),
  idempotencyKey: z.string().min(8).max(128),
  operation: audioOperationKindSchema,
  videoAssetId: z.uuid(),
  expectedVideoSha256: digest,
  /** Index among the file's video streams, as in FFmpeg `0:v:<index>`. */
  videoStreamIndex: streamIndex,
  /** Index among the video file's audio streams (`0:a:<index>`). */
  sourceAudioStreamIndex: streamIndex.optional(),
  audioAssetId: z.uuid().optional(),
  expectedAudioSha256: digest.optional(),
  /** Index among the audio asset's audio streams (`1:a:<index>`). */
  audioStreamIndex: streamIndex.optional(),
  shortAudio: shortAudioPolicySchema.optional(),
  longAudio: longAudioPolicySchema.optional(),
  /** Placement of the external audio on the fixed video timeline. */
  offsetSeconds: seconds.default(0),
  /** Trim range inside the external audio asset. */
  audioStartSeconds: seconds.default(0),
  audioEndSeconds: seconds.optional(),
  /** Gain for the video file's own audio track (preserve/mix). */
  sourceGainDb: gainDb.default(0),
  /** Gain for the external audio asset (replace/mix). */
  audioGainDb: gainDb.default(0),
  loudness: z.object({ mode: z.literal("measure_only") }).strict().default({ mode: "measure_only" }),
}).strict().superRefine((request, ctx) => {
  const need = (condition: boolean, path: string, message: string) => {
    if (!condition) ctx.addIssue({ code: "custom", path: [path], message });
  };
  const hasExternal = request.audioAssetId !== undefined;
  const hasDurationPolicy = request.shortAudio !== undefined && request.longAudio !== undefined;
  switch (request.operation) {
    case "extract":
      need(request.sourceAudioStreamIndex !== undefined, "sourceAudioStreamIndex", "Extract requires an explicit source audio stream index");
      need(!hasExternal && request.expectedAudioSha256 === undefined && request.audioStreamIndex === undefined, "audioAssetId", "Extract does not accept an external audio asset");
      need(request.shortAudio === undefined && request.longAudio === undefined, "shortAudio", "Extract has no duration policy; the extracted track keeps its own duration");
      need(request.offsetSeconds === 0 && request.audioStartSeconds === 0 && request.audioEndSeconds === undefined, "offsetSeconds", "Extract does not accept offset or trim range");
      break;
    case "preserve":
      need(request.sourceAudioStreamIndex !== undefined, "sourceAudioStreamIndex", "Preserve requires an explicit source audio stream index");
      need(!hasExternal && request.expectedAudioSha256 === undefined && request.audioStreamIndex === undefined, "audioAssetId", "Preserve does not accept an external audio asset");
      need(hasDurationPolicy, "shortAudio", "Preserve requires explicit shortAudio and longAudio policies");
      need(request.offsetSeconds === 0 && request.audioStartSeconds === 0 && request.audioEndSeconds === undefined, "offsetSeconds", "Preserve keeps the source track on its own timeline; offset and trim range are not accepted");
      break;
    case "mute":
      need(request.sourceAudioStreamIndex === undefined, "sourceAudioStreamIndex", "Mute does not select a source audio stream");
      need(!hasExternal && request.expectedAudioSha256 === undefined && request.audioStreamIndex === undefined, "audioAssetId", "Mute does not accept an external audio asset");
      need(request.shortAudio === undefined && request.longAudio === undefined, "shortAudio", "Mute has no duration policy; the output has no audio stream");
      need(request.offsetSeconds === 0 && request.audioStartSeconds === 0 && request.audioEndSeconds === undefined, "offsetSeconds", "Mute does not accept offset or trim range");
      break;
    case "replace":
      need(request.sourceAudioStreamIndex === undefined, "sourceAudioStreamIndex", "Replace does not select a source audio stream");
      need(hasExternal && request.expectedAudioSha256 !== undefined && request.audioStreamIndex !== undefined, "audioAssetId", "Replace requires an audio asset, its expected SHA-256 and an explicit audio stream index");
      need(hasDurationPolicy, "shortAudio", "Replace requires explicit shortAudio and longAudio policies");
      break;
    case "mix":
      need(request.sourceAudioStreamIndex !== undefined, "sourceAudioStreamIndex", "Mix requires an explicit source audio stream index");
      need(hasExternal && request.expectedAudioSha256 !== undefined && request.audioStreamIndex !== undefined, "audioAssetId", "Mix requires an audio asset, its expected SHA-256 and an explicit audio stream index");
      need(hasDurationPolicy, "shortAudio", "Mix requires explicit shortAudio and longAudio policies");
      break;
  }
  if (request.audioEndSeconds !== undefined) {
    need(request.audioEndSeconds > request.audioStartSeconds, "audioEndSeconds", "audioEndSeconds must be after audioStartSeconds");
  }
  if (request.operation !== "mix" && request.operation !== "preserve") {
    need(request.sourceGainDb === 0, "sourceGainDb", "sourceGainDb only applies to preserve and mix");
  }
  if (request.operation !== "replace" && request.operation !== "mix") {
    need(request.audioGainDb === 0, "audioGainDb", "audioGainDb only applies to replace and mix");
  }
});
export type AudioOperationRequest = z.infer<typeof audioOperationRequestSchema>;

export const audioMeasurementSchema = z.object({
  /** Null when the measured audio is silent; silence is never reported as finite LUFS. */
  integratedLufs: z.number().finite().nullable(),
  truePeakDb: z.number().finite().nullable(),
  loudnessRangeLu: z.number().finite().nullable(),
  silence: z.boolean(),
}).strict();
export type AudioMeasurement = z.infer<typeof audioMeasurementSchema>;

/**
 * Server-created provenance/validation receipt. Clients never supply one:
 * the request schema above is strict and has no receipt field.
 */
export const audioReceiptSchema = z.object({
  version: z.literal(AUDIO_POLICY_VERSION),
  contract: z.literal("audio_policy_v1"),
  operationId: z.uuid(),
  operation: audioOperationKindSchema,
  projectId: z.uuid(),
  videoAssetId: z.uuid(),
  videoSha256: digest,
  audioAssetId: z.uuid().nullable(),
  audioSha256: digest.nullable(),
  outputAssetId: z.uuid(),
  outputSha256: digest,
  outputMediaType: z.enum(["video", "audio"]),
  outputContentType: z.string().min(1),
  videoDurationSeconds: z.number().finite().positive(),
  outputDurationSeconds: z.number().finite().positive(),
  /** Decoded video frame timestamps of input and output; equal for mux operations. */
  videoTimingDigest: digest.nullable(),
  videoFrames: z.number().int().nonnegative().nullable(),
  /** Null only for mute, whose output deliberately has no audio stream. */
  measurement: audioMeasurementSchema.nullable(),
  loudnessMode: z.literal("measure_only"),
  tools: z.object({ ffmpeg: z.string().min(1), ffprobe: z.string().min(1) }).strict(),
  validatedAt: z.iso.datetime(),
}).strict();
export type AudioReceipt = z.infer<typeof audioReceiptSchema>;

/** The asset fields a completed operation publishes, decided by the operation alone. */
export function audioOutputKind(operation: AudioOperationKind): { mediaType: "video" | "audio"; contentType: string; extension: string } {
  return operation === "extract"
    ? { mediaType: "audio", contentType: "audio/wav", extension: "wav" }
    : { mediaType: "video", contentType: "video/mp4", extension: "mp4" };
}

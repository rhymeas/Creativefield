import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { audioOperationRequestSchema } from "../server/audio-policy";
import { buildAudioFfmpegArgs, planTimelineFit } from "../server/audio-processing";

const sha = "a".repeat(64);
const base = {
  projectId: randomUUID(),
  idempotencyKey: "audio-key-123456",
  videoAssetId: randomUUID(),
  expectedVideoSha256: sha,
  videoStreamIndex: 0,
};
const external = { audioAssetId: randomUUID(), expectedAudioSha256: "b".repeat(64), audioStreamIndex: 0 };
const policies = { shortAudio: "pad_silence" as const, longAudio: "trim" as const };

describe("audio policy contract", () => {
  it("accepts all five operations with their required pins", () => {
    expect(audioOperationRequestSchema.parse({ ...base, operation: "extract", sourceAudioStreamIndex: 0 }).operation).toBe("extract");
    expect(audioOperationRequestSchema.parse({ ...base, operation: "preserve", sourceAudioStreamIndex: 1, ...policies }).sourceAudioStreamIndex).toBe(1);
    expect(audioOperationRequestSchema.parse({ ...base, operation: "mute" }).operation).toBe("mute");
    expect(audioOperationRequestSchema.parse({ ...base, operation: "replace", ...external, ...policies, offsetSeconds: 0.5, audioStartSeconds: 1, audioEndSeconds: 3, audioGainDb: -3 }).audioGainDb).toBe(-3);
    expect(audioOperationRequestSchema.parse({ ...base, operation: "mix", sourceAudioStreamIndex: 0, ...external, ...policies, sourceGainDb: -6 }).sourceGainDb).toBe(-6);
  });
  it("rejects missing policies, wrong pins, client receipts and normalization", () => {
    expect(() => audioOperationRequestSchema.parse({ ...base, operation: "replace", ...external })).toThrow();
    expect(() => audioOperationRequestSchema.parse({ ...base, operation: "preserve", ...policies })).toThrow();
    expect(() => audioOperationRequestSchema.parse({ ...base, operation: "mute", ...external })).toThrow();
    expect(() => audioOperationRequestSchema.parse({ ...base, operation: "mute", offsetSeconds: 1 })).toThrow();
    expect(() => audioOperationRequestSchema.parse({ ...base, operation: "mute", audioEndSeconds: 1 })).toThrow();
    expect(() => audioOperationRequestSchema.parse({ ...base, operation: "mute", receipt: { fake: true } })).toThrow();
    expect(() => audioOperationRequestSchema.parse({ ...base, operation: "mute", loudness: { mode: "normalize", targetLufs: -14 } })).toThrow();
    expect(() => audioOperationRequestSchema.parse({ ...base, operation: "extract", sourceAudioStreamIndex: 0, ...policies })).toThrow();
    expect(() => audioOperationRequestSchema.parse({ ...base, operation: "replace", ...external, ...policies, audioEndSeconds: 1, audioStartSeconds: 2 })).toThrow();
    expect(() => audioOperationRequestSchema.parse({ ...base, operation: "replace", ...external, ...policies, audioGainDb: 99 })).toThrow();
  });
  it("plans only the declared short/long behavior", () => {
    const plan = (end: number, shortAudio: "reject" | "pad_silence", longAudio: "reject" | "trim") =>
      planTimelineFit({ videoDurationSeconds: 4, endOnTimelineSeconds: end, shortAudio, longAudio, track: "External audio" });
    expect(plan(4, "reject", "reject")).toBe("exact");
    expect(plan(4.05, "reject", "reject")).toBe("exact");
    expect(plan(2, "pad_silence", "reject")).toBe("pad_silence");
    expect(plan(6, "reject", "trim")).toBe("trim");
    expect(() => plan(2, "reject", "trim")).toThrow(/shortAudio is reject/);
    expect(() => plan(6, "pad_silence", "reject")).toThrow(/longAudio is reject/);
  });
  it("builds explicit stream maps for every operation", () => {
    const build = (request: unknown) => buildAudioFfmpegArgs({
      request: audioOperationRequestSchema.parse(request),
      videoFile: "video.mp4", audioFile: "audio.wav", outputFile: "out.bin",
      videoDurationSeconds: 4, expectedAudioChannels: 2, maxBytes: 1000,
    }).join(" ");
    expect(build({ ...base, operation: "extract", sourceAudioStreamIndex: 1 })).toContain("-map 0:a:1");
    expect(build({ ...base, operation: "extract", sourceAudioStreamIndex: 1 })).toContain("pcm_s16le");
    expect(build({ ...base, operation: "mute" })).toContain("-map 0:v:0");
    expect(build({ ...base, operation: "mute" })).toContain("-an");
    expect(build({ ...base, operation: "preserve", sourceAudioStreamIndex: 0, ...policies })).toContain("[0:a:0]");
    expect(build({ ...base, operation: "preserve", sourceAudioStreamIndex: 0, ...policies })).toContain("-c:v copy");
    expect(build({ ...base, operation: "replace", ...external, ...policies, offsetSeconds: 1 })).toContain("[1:a:0]");
    expect(build({ ...base, operation: "replace", ...external, ...policies, offsetSeconds: 1 })).toContain("adelay=delays=1000:all=1");
    expect(build({ ...base, operation: "mix", sourceAudioStreamIndex: 0, ...external, ...policies })).toContain("amix=inputs=2");
    expect(build({ ...base, operation: "mix", sourceAudioStreamIndex: 0, ...external, ...policies })).toContain("normalize=0");
    for (const args of [build({ ...base, operation: "mute" })]) expect(args).toContain("-nostdin");
  });
});

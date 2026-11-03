import { beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DiskStore } from "../server/storage";
import { fileSha256 } from "../server/masked-media";
import { audioOperationRequestSchema, type AudioOperationRequest } from "../server/audio-policy";
import { processAudioOperation } from "../server/audio-processing";
import { probeMedia } from "../server/audio-processing-validation";

const execute = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";

describe("real FFmpeg audio processing", () => {
  let dir: string, store: DiskStore, workspaceId: string;
  let videoFile: string, delayedAudioVideoFile: string, longTrackVideoFile: string, silentVideoFile: string, multiFile: string, toneFile: string, shortToneFile: string, longToneFile: string;
  const projectId = randomUUID();
  const mk = async (name: string, args: string[]) => {
    const file = path.join(dir, name);
    await execute(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args, file], { windowsHide: true, timeout: 120000 });
    return file;
  };
  beforeAll(async () => {
    dir = await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform/audio-test-");
    store = new DiskStore(path.join(dir, "store"), 16 * 1024 * 1024);
    workspaceId = randomUUID();
    videoFile = await mk("video.mp4", ["-f", "lavfi", "-i", "color=c=red:s=160x96:r=16:d=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2"]);
    delayedAudioVideoFile = await mk("delayed-audio.mp4", ["-f", "lavfi", "-i", "color=c=red:s=160x96:r=16:d=2", "-itsoffset", "0.5", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.5", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-t", "2"]);
    longTrackVideoFile = await mk("long-track.mp4", ["-f", "lavfi", "-i", "color=c=red:s=160x96:r=16:d=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2"]);
    silentVideoFile = await mk("silent.mp4", ["-f", "lavfi", "-i", "color=c=blue:s=160x96:r=16:d=2", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=2", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2"]);
    multiFile = await mk("multi.mp4", ["-f", "lavfi", "-i", "color=c=green:s=160x96:r=16:d=3", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=1", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=3", "-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "1"]);
    toneFile = await mk("tone.wav", ["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=44100:duration=2", "-c:a", "pcm_s16le", "-ac", "1"]);
    shortToneFile = await mk("short.wav", ["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=0.5", "-c:a", "pcm_s16le", "-ac", "2"]);
    longToneFile = await mk("long.wav", ["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=5", "-c:a", "pcm_s16le", "-ac", "2"]);
  }, 60000);

  async function run(partial: Record<string, unknown>, video = videoFile, audio?: string) {
    const request: AudioOperationRequest = audioOperationRequestSchema.parse({
      projectId, idempotencyKey: `key-${randomUUID()}`, videoAssetId: randomUUID(),
      expectedVideoSha256: await fileSha256(video), videoStreamIndex: 0,
      ...(audio ? { audioAssetId: randomUUID(), expectedAudioSha256: await fileSha256(audio), audioStreamIndex: 0 } : {}),
      ...partial,
    });
    return processAudioOperation({ store, workspaceId, request, videoFile: video, audioFile: audio, signal: new AbortController().signal });
  }
  const policies = { shortAudio: "pad_silence", longAudio: "trim" } as const;
  const scratchEntries = async () => readdir(path.join(store.root, ".audio-processing")).catch(() => []);

  it("extracts a 16-bit PCM WAV and selects among multiple audio streams", async () => {
    const first = await run({ operation: "extract", sourceAudioStreamIndex: 0 }, multiFile);
    expect(first.outputDurationSeconds).toBeCloseTo(1, 0);
    const second = await run({ operation: "extract", sourceAudioStreamIndex: 1 }, multiFile);
    expect(second.outputDurationSeconds).toBeCloseTo(3, 0);
    expect(second.measurement?.integratedLufs).toBeTypeOf("number");
    expect(await fileSha256(await store.file(workspaceId, second.key))).toBe(second.sha256);
    expect(await scratchEntries()).toEqual([]);
  }, 120000);
  it("preserves, mutes, replaces and mixes on the fixed timeline", async () => {
    const before = await fileSha256(videoFile);
    const preserved = await run({ operation: "preserve", sourceAudioStreamIndex: 0, ...policies });
    expect(preserved.videoFrames).toBe(32);
    expect(preserved.outputDurationSeconds).toBeCloseTo(2, 1);
    const muted = await run({ operation: "mute" });
    expect(muted.measurement).toBeNull();
    const mutedInfo = await probeMedia(await store.file(workspaceId, muted.key), "video");
    expect(mutedInfo.streams.some(s => s.codecType === "audio")).toBe(false);
    const trimmedSource = await run({ operation: "preserve", sourceAudioStreamIndex: 0, ...policies }, longTrackVideoFile);
    expect(trimmedSource.outputDurationSeconds).toBeCloseTo(2, 1);
    const mutedLongTrack = await run({ operation: "mute" }, longTrackVideoFile);
    expect(mutedLongTrack.outputDurationSeconds).toBeCloseTo(2, 1);
    const replaced = await run({ operation: "replace", ...policies }, videoFile, toneFile);
    expect(replaced.videoTimingDigest).toBe(preserved.videoTimingDigest);
    const mixed = await run({ operation: "mix", sourceAudioStreamIndex: 0, ...policies, sourceGainDb: -6, audioGainDb: -6 }, videoFile, longToneFile);
    expect(mixed.outputDurationSeconds).toBeCloseTo(2, 1);
    expect(await fileSha256(videoFile)).toBe(before);
    expect(await scratchEntries()).toEqual([]);
  }, 120000);
  it("enforces reject/pad/trim, offsets and missing source audio", async () => {
    await expect(run({ operation: "replace", shortAudio: "reject", longAudio: "trim" }, videoFile, shortToneFile)).rejects.toThrow(/shortAudio is reject/);
    await expect(run({ operation: "replace", shortAudio: "pad_silence", longAudio: "reject" }, videoFile, longToneFile)).rejects.toThrow(/longAudio is reject/);
    const padded = await run({ operation: "replace", ...policies, offsetSeconds: 1.5 }, videoFile, shortToneFile);
    expect(padded.outputDurationSeconds).toBeCloseTo(2, 1);
    await expect(run({ operation: "replace", ...policies, offsetSeconds: 2 }, videoFile, shortToneFile)).rejects.toThrow(/before the fixed video timeline ends/);
    const noAudio = await mk("no-audio.mp4", ["-f", "lavfi", "-i", "color=c=white:s=160x96:r=16:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an"]);
    await expect(run({ operation: "preserve", sourceAudioStreamIndex: 0, ...policies }, noAudio)).rejects.toThrow(/silence is not synthesized/);
    await expect(run({ operation: "preserve", sourceAudioStreamIndex: 0, ...policies }, delayedAudioVideoFile)).rejects.toThrow(/would shift its synchronization/);
    await expect(run({ operation: "extract", sourceAudioStreamIndex: 3 }, videoFile)).rejects.toThrow(/missing/);
    expect(await scratchEntries()).toEqual([]);
  }, 60000);
  it("reports silence explicitly and rejects corrupt media", async () => {
    const silent = await run({ operation: "preserve", sourceAudioStreamIndex: 0, ...policies }, silentVideoFile);
    expect(silent.measurement?.silence).toBe(true);
    expect(silent.measurement?.integratedLufs).toBeNull();
    const corrupt = path.join(dir, "corrupt.mp4");
    await writeFile(corrupt, "not media at all");
    await expect(run({ operation: "mute" }, corrupt)).rejects.toThrow();
    expect(await scratchEntries()).toEqual([]);
  }, 60000);
  it("cleans scratch and stores no candidate when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = audioOperationRequestSchema.parse({
      projectId, idempotencyKey: `key-${randomUUID()}`, operation: "mute", videoAssetId: randomUUID(),
      expectedVideoSha256: await fileSha256(videoFile), videoStreamIndex: 0,
    });
    await expect(processAudioOperation({ store, workspaceId, request, videoFile, signal: controller.signal })).rejects.toThrow(/interrupted/);
    expect(await scratchEntries()).toEqual([]);
    void createReadStream;
  }, 120000);
});

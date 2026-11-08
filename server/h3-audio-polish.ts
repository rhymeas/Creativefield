import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hasOwnVideoFinish } from "./chain-upscale";
import { VIDEO_REFRAME_ID } from "../src/capabilities/video-reframe";
import { ffmpegPath, probeMedia, runTool, streamsOfType } from "./audio-processing-validation";

const h3VideoPacks = new Set([
  VIDEO_REFRAME_ID,
  "h3-t2v", "h3-i2v", "h3-flf2v", "h3-effects", "minimax-h3-video",
  "h3-object-swap", "h3-object-swap-hyperflow", "openjutsu-h3-swap", "openjutsu-h3-swap-hyperflow", "openjutsu-h3-advanced", "previs-to-video", "previs-to-video-hyperflow",
]);

export const usesH3AudioPolish = (id: string) => hasOwnVideoFinish(id) || h3VideoPacks.has(id);

const filter = [
  "highpass=f=80", "lowpass=f=14000", "deesser=i=0.12:m=0.35:f=0.5",
  "acompressor=threshold=0.125:ratio=1.7:attack=15:release=130",
  // Leave half a dB for AAC encoding overshoot.
  "loudnorm=I=-16:TP=-2:LRA=11",
].join(",");

/** Stream-copy the picture and original audio, adding the polished track first. */
export async function withPolishedH3Audio<T>(source: string, use: (file: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(dirname(source), ".h3-audio-"));
  const output = join(folder, "polished.mp4");
  try {
    const originalAudioCount = streamsOfType(await probeMedia(source, "video"), "audio").length;
    await runTool(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file,pipe",
      "-format_whitelist", "mov", "-i", source, "-map", "0:v:0", "-map", "0:a:0", "-map", "0:a",
      "-c:v", "copy", "-c:a", "copy", "-c:a:0", "aac", "-b:a:0", "192k", "-ar:a:0", "48000",
      "-filter:a:0", filter, "-disposition:a", "-default", "-disposition:a:0", "default",
      "-metadata:s:a:0", "handler_name=Polished audio", "-metadata:s:a:1", "handler_name=Original audio",
      "-movflags", "+faststart", output,
    ], undefined, 30000);
    const result = await probeMedia(output, "video");
    if (streamsOfType(result, "video").length !== 1 || streamsOfType(result, "audio").length !== originalAudioCount + 1) {
      throw new Error("Polished video does not contain the expected audio tracks");
    }
    return await use(output);
  } finally {
    await unlink(output).catch(() => {});
    await rmdir(folder).catch(() => {});
  }
}

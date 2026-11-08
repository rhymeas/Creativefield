import {mkdtemp, rmdir, unlink} from "node:fs/promises";
import {dirname, join} from "node:path";
import {reframeSize} from "../src/capabilities/video-reframe";
import {AudioProcessingError, ffmpegPath, runTool} from "./audio-processing-validation";
import {inspectNormalizedVideo, VideoExtensionMediaError} from "./video-extension-media";

export async function inspectReframeSource(source: string, aspect: unknown) {
  const size = reframeSize(aspect);
  if (!size) throw new VideoExtensionMediaError("Choose an output aspect ratio.");
  const facts = await inspectNormalizedVideo(source);
  if (facts.width * size.height === facts.height * size.width) {
    throw new VideoExtensionMediaError("This clip already has that aspect ratio. Choose another format.");
  }
  const seconds = facts.frameCount * facts.frameRate.denominator / facts.frameRate.numerator;
  if (seconds < 0.25 || seconds > 15) {
    throw new VideoExtensionMediaError("Choose a clip between a quarter of a second and 15 seconds.");
  }
  return {size, facts};
}

/** The worker finishes the picture. The source owns the delivered soundtrack. */
export async function withReframedAudio<T>(source: string, output: string, aspect: unknown, use: (file: string) => Promise<T>): Promise<T> {
  const [{size, facts}, video] = await Promise.all([inspectReframeSource(source, aspect), inspectNormalizedVideo(output)]);
  if (video.width !== size.width || video.height !== size.height || video.frameCount !== facts.frameCount
    || video.frameRate.numerator * facts.frameRate.denominator !== facts.frameRate.numerator * video.frameRate.denominator) {
    throw new VideoExtensionMediaError("Reframing changed the source timing or returned a different aspect ratio.");
  }
  if (!facts.hasAudio && !video.hasAudio) return use(output);

  const scratch = await mkdtemp(join(dirname(output), ".reframe-"));
  const merged = join(scratch, "reframed.mp4");
  const merge = (audioCodec: string) => runTool(ffmpegPath(), [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-i", output,
    "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-i", source,
    "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy", "-c:a", audioCodec,
    "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", merged,
  ], undefined, 30000);
  try {
    try { await merge("copy"); }
    catch (error) {
      if (!facts.hasAudio || !(error instanceof AudioProcessingError)) throw error;
      await merge("aac");
    }
    const result = await inspectNormalizedVideo(merged);
    if (result.hasAudio !== facts.hasAudio || result.timestampDigest !== video.timestampDigest
      || (facts.audioSeconds !== null && result.audioSeconds !== null && Math.abs(facts.audioSeconds - result.audioSeconds) > 0.06)) {
      throw new VideoExtensionMediaError("The reframed clip did not retain the original soundtrack and timing.");
    }
    return await use(merged);
  } finally {
    await unlink(merged).catch(() => {});
    await rmdir(scratch).catch(() => {});
  }
}

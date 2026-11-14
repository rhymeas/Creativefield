import {mkdtemp, mkdir, rm} from "node:fs/promises";
import {dirname, join} from "node:path";
import {AudioProcessingError, ffmpegPath, ffprobePath, probeMedia, runTool, type MediaStream} from "./audio-processing-validation";

const FPS = 24;
// The upstream planner rounds its last window down to the 5 + 17n grid.
// Supply one grid interval minus one frame so even the final partial window is covered.
const TAIL_FRAMES = 16;
const input = (file: string) => ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-i", file];
const encode = (args: string[]) => runTool(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], undefined, 300000);
const videoEncoding = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p"];

function soundtrackAtFirstFrame(video: MediaStream | undefined, audio: MediaStream): string {
  const offset = (audio.startTime ?? 0) - (video?.startTime ?? 0);
  const seconds = Number.isFinite(offset) ? offset.toFixed(6) : "0";
  return `asetpts=PTS-STARTPTS+(${seconds})/TB,aresample=first_pts=0,apad`;
}

async function framesAt24(file: string) {
  const {stdout} = await runTool(ffprobePath(), ["-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=nb_read_frames,avg_frame_rate", "-of", "json", ...input(file)], undefined, 120000);
  const video = JSON.parse(stdout).streams?.[0];
  const [numerator, denominator] = String(video?.avg_frame_rate).split("/").map(Number);
  const frames = Number(video?.nb_read_frames);
  if (numerator / denominator !== FPS || !Number.isSafeInteger(frames) || frames < 1)
    throw new AudioProcessingError("OpenJutsu needs a readable 24 fps video timeline.");
  return frames;
}

/** Carry the source length in the run-owned input filename, which is already
 * persisted in the submitted graph. Earlier graphs have no timeline marker. */
export function openJutsuFlashSourceFrames(video: unknown, runId: string): number | undefined {
  if (typeof video !== "string" || !video.startsWith(`comfyfield-${runId}-`)) return;
  const match = /-oj24-([1-9]\d*)\.mp4$/.exec(video);
  const frames = Number(match?.[1]);
  if (Number.isSafeInteger(frames) && frames > 0) return frames;
}

export async function withPaddedOpenJutsuFlashSource<T>(source: string, use: (file: string, suffix: string) => Promise<T>): Promise<T> {
  const {streams} = await probeMedia(source, "video");
  const audio = streams.find(stream => stream.codecType === "audio");
  const video = streams.find(stream => stream.codecType === "video");
  const root = join(process.cwd(), ".comfyfield", "tmp");
  await mkdir(root, {recursive: true});
  const scratch = await mkdtemp(join(root, "openjutsu-source-"));
  const file = join(scratch, "source.mp4");
  try {
    const audioInput = audio ? [] : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"];
    await encode([...input(source), ...audioInput, "-map", "0:v:0", "-map", audio ? "0:a:0" : "1:a:0",
      "-vf", `setpts=PTS-STARTPTS,fps=${FPS}:start_time=0,pad=ceil(iw/2)*2:ceil(ih/2)*2,tpad=stop_mode=clone:stop=${TAIL_FRAMES}`,
      ...videoEncoding, "-af", audio ? soundtrackAtFirstFrame(video, audio) : "apad", "-c:a", "aac", "-shortest", file]);
    const frames = await framesAt24(file) - TAIL_FRAMES;
    if (frames < 1) throw new AudioProcessingError("The source has no frames on the OpenJutsu timeline.");
    return await use(file, `-oj24-${frames}.mp4`);
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
}

/** Remove the working tail and use the real source soundtrack before audio polish. */
export async function withExactOpenJutsuFlashOutput<T>(source: string, rendered: string, frames: number, use: (file: string) => Promise<T>): Promise<T> {
  const [renderedFrames, media] = await Promise.all([framesAt24(rendered), probeMedia(source, "video")]);
  if (renderedFrames < frames || renderedFrames > frames + TAIL_FRAMES)
    throw new AudioProcessingError(`OpenJutsu returned ${renderedFrames} frames for a ${frames}-frame source.`);
  const soundtrack = media.streams.find(stream => stream.codecType === "audio");
  const video = media.streams.find(stream => stream.codecType === "video");
  const picture = renderedFrames === frames ? ["-c:v", "copy"] : ["-vf", `trim=end_frame=${frames}`, ...videoEncoding];
  const audio = soundtrack ? ["-map", "1:a:0", "-af", `${soundtrackAtFirstFrame(video, soundtrack)},atrim=duration=${frames / FPS}`, "-c:a", "aac"] : [];
  const scratch = await mkdtemp(join(dirname(rendered), ".openjutsu-"));
  const file = join(scratch, "output.mp4");
  try {
    await encode([...input(rendered), ...(soundtrack ? input(source) : []), "-map", "0:v:0", ...picture, ...audio, "-movflags", "+faststart", file]);
    if (await framesAt24(file) !== frames) throw new AudioProcessingError("OpenJutsu output did not retain the complete source timeline.");
    return await use(file);
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
}

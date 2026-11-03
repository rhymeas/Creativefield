import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { rasterFrame } from "./raster";
import { STAGE_FPS, depthFar, stageFrames, stageSize, type StageScene } from "./stage";

export type BlockingRender = { clay: string; depth: string; frames: number; width: number; height: number; fps: number };

/** Both passes are encoded with identical settings, so their size, frame count and every timestamp line up exactly. */
function encoder(out: string, w: number, h: number, fps: number = STAGE_FPS) {
  const child = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-r", String(fps), "-i", "pipe:0", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "12", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  (child.stderr as NodeJS.ReadableStream).on("data", (d: Buffer) => { stderr += d; });
  const closed = new Promise<void>((resolve, reject) => child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 300)}`))));
  return {
    async write(buffer: Buffer) { if (!child.stdin.write(buffer)) await once(child.stdin, "drain"); },
    async end() { child.stdin.end(); await closed; },
  };
}

/** Draws the grey-box clip and its depth pass for a scene, frame by frame, into two MP4 files in `dir`. */
export async function renderBlocking(scene: StageScene, seconds: number, dir: string, signal?: AbortSignal, fps: number = STAGE_FPS): Promise<BlockingRender> {
  await mkdir(dir, { recursive: true });
  const { w, h } = stageSize(scene.aspect), frames = stageFrames(seconds, fps), far = depthFar(scene);
  const clay = path.join(dir, "layout.mp4"), depth = path.join(dir, "depth.mp4");
  const a = encoder(clay, w, h, fps), b = encoder(depth, w, h, fps);
  let drawingError: unknown;
  try {
    for (let i = 0; i < frames; i++) {
      signal?.throwIfAborted();
      const frame = rasterFrame(scene, frames > 1 ? i / (frames - 1) : 0, w, h, far);
      await Promise.all([a.write(frame.clay), b.write(frame.depth)]);
    }
  } catch (error) {
    drawingError = error;
  }
  const endings = await Promise.allSettled([a.end(), b.end()]);
  if (drawingError) throw drawingError;
  const failed = endings.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  return { clay, depth, frames, width: w, height: h, fps };
}

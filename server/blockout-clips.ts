/*
 * Determinstic grey-block clip export. The browser renders the shot at exact
 * frame times (24 fps by default) instead of recording real time, posts the
 * JPEG frames here, and FFmpeg encodes them into a normal H.264 MP4. This
 * replaces MediaRecorder for the handoff: the same score always yields the same
 * frames, independent of CPU speed or dropped frames.
 */
import {execFile} from "node:child_process";
import {createReadStream} from "node:fs";
import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {promisify} from "node:util";
import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {HttpError, member} from "./auth";
import {newId} from "./crypto";
import {probeVideo} from "./media";
import type {DiskStore} from "./storage";

const execute = promisify(execFile);
const MAX_FRAMES = 480;
const MAX_FRAME_CHARS = 2_000_000;
const BODY_LIMIT = 64 * 1024 * 1024;

const body = z.object({
  name: z.string().min(1).max(200).optional(),
  projectId: z.uuid().optional(),
  fps: z.number().int().min(6).max(60),
  frames: z.array(z.string().min(16).max(MAX_FRAME_CHARS)).min(2).max(MAX_FRAMES),
}).strict();

const JPEG = /^data:image\/jpeg;base64,([A-Za-z0-9+/=\s]+)$/;

export async function blockoutClipRoutes(app: FastifyInstance, pool: Pool, store: DiskStore) {
  app.post("/api/v1/workspaces/:workspaceId/blockout-clips", {bodyLimit: BODY_LIMIT}, async (request) => {
    const {workspaceId} = z.object({workspaceId: z.uuid()}).parse(request.params);
    const user = await member(pool, request, workspaceId, "creator");
    const input = body.parse(request.body ?? {});
    const directory = join(process.cwd(), ".comfyfield", "tmp", `blockout-${randomUUID()}`);
    const output = join(directory, "shot.mp4");
    await mkdir(directory, {recursive: true});
    try {
      for (const [index, frame] of input.frames.entries()) {
        const match = JPEG.exec(frame);
        if (!match) throw new HttpError(400, "Blockout frames must be JPEG data URLs.");
        const bytes = Buffer.from(match[1], "base64");
        if (!bytes.length) throw new HttpError(400, "A blockout frame is empty.");
        await writeFile(join(directory, `frame-${String(index).padStart(5, "0")}.jpg`), bytes);
      }
      try {
        await execute(process.env.FFMPEG_PATH ?? "ffmpeg", [
          "-hide_banner", "-y",
          "-framerate", String(input.fps),
          "-i", join(directory, "frame-%05d.jpg"),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
          "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
          output,
        ], {timeout: 240_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true});
      } catch (error) {
        const message = (error as {stderr?: string}).stderr ?? "";
        if (/ENOENT/.test((error as NodeJS.ErrnoException).code ?? "")) throw new HttpError(503, "This team server needs FFmpeg with libx264 to encode the blockout clip.");
        throw new HttpError(422, `The blockout clip could not be encoded${message ? `: ${message.split(/\r?\n/).filter(Boolean).pop()}` : "."}`);
      }
      const probe = await probeVideo(output);
      const stored = await store.put(workspaceId, createReadStream(output));
      const id = newId();
      const name = input.name?.trim() || `blockout-${String(Math.round(probe.durationSeconds * input.fps))}f-${input.fps}fps.mp4`;
      await pool.query(
        "INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata) VALUES($1,$2,$3,$4,'video','video/mp4',$5,$6,$7,$8,$9)",
        [id, workspaceId, input.projectId ?? null, name.slice(0, 200), stored.key, stored.sha256, stored.bytes, user.id, JSON.stringify({blockout: {fps: input.fps, frames: input.frames.length, width: probe.width, height: probe.height}})],
      );
      return {
        id,
        name,
        bytes: stored.bytes,
        width: probe.width,
        height: probe.height,
        durationSeconds: probe.durationSeconds,
        fps: input.fps,
        frames: input.frames.length,
      };
    } finally {
      await rm(directory, {recursive: true, force: true}).catch(() => undefined);
    }
  });
}

/** Exposed for a future direct upload path; keeps the frame-count/limit contract in one place. */
export const blockoutClipLimits = {maxFrames: MAX_FRAMES, bodyLimit: BODY_LIMIT, maxFrameChars: MAX_FRAME_CHARS} as const;

/** Read a rendered JPEG frame as bytes; separate for tests. */
export function frameBytes(frame: string): Buffer {
  const match = JPEG.exec(frame);
  if (!match) throw new HttpError(400, "Blockout frames must be JPEG data URLs.");
  return Buffer.from(match[1], "base64");
}

/** The encoded file is read back once for probing; kept typed so the route and tests agree. */
export async function readRendered(path: string): Promise<Buffer> {
  return readFile(path);
}

/*
 * Reference shot detection: an uploaded clip is written to a temporary file and
 * probed with FFmpeg. `scdet` finds hard cuts far more reliably than a colour
 * histogram, and the same file is what the later geometry pass will read, so
 * the clip is the server's source of truth for shot boundaries.
 *
 * This route never stores the upload: it deletes the temporary file when the
 * probe finishes. The browser keeps its local copy for playback.
 */
import {execFile} from "node:child_process";
import {createWriteStream} from "node:fs";
import {mkdir, unlink} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {promisify} from "node:util";
import {pipeline} from "node:stream/promises";
import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {HttpError, member} from "./auth";
import {probeVideo} from "./media";

const execute = promisify(execFile);
const CUT_THRESHOLD = 8;
const MAX_CUTS = 64;

/** FFmpeg's scdet filter logs one `lavfi.scd.time:` line per detected change. */
export function parseScdetTimes(log: string): number[] {
  const times: number[] = [];
  for (const match of log.matchAll(/lavfi\.scd\.time:\s*([0-9]+(?:\.[0-9]+)?)/g)) {
    const time = Number(match[1]);
    if (Number.isFinite(time) && time > 0) times.push(Math.round(time * 100) / 100);
  }
  return [...new Set(times)].sort((left, right) => left - right).slice(0, MAX_CUTS);
}

/** The studio's shot list from detected cut times; never zero shots. */
export function shotsFromCuts(durationSec: number, cuts: number[]): Array<{start: number; end: number}> {
  const end = Math.max(0.2, durationSec);
  const inside = cuts.filter((cut) => cut > 0.2 && cut < end - 0.2);
  const bounds = [0, ...inside, end];
  return bounds.slice(1).map((stop, index) => ({start: bounds[index], end: stop}));
}

export async function referenceShotsRoutes(app: FastifyInstance, pool: Pool) {
  app.post("/api/v1/workspaces/:workspaceId/reference-shots", async (request) => {
    const {workspaceId} = z.object({workspaceId: z.uuid()}).parse(request.params);
    await member(pool, request, workspaceId);
    const file = await request.file();
    if (!file) throw new HttpError(400, "Choose a reference clip first.");
    const type = file.mimetype || "";
    const looksLikeVideo = type.startsWith("video/") || /\.(mp4|webm|mov|m4v|mkv)$/i.test(file.filename ?? "");
    if (!looksLikeVideo) throw new HttpError(400, "The reference must be a video file.");
    const directory = join(process.cwd(), ".comfyfield", "tmp");
    await mkdir(directory, {recursive: true});
    const suffix = (file.filename ?? "").toLowerCase().match(/\.(mp4|webm|mov|m4v|mkv)$/)?.[0] ?? ".mp4";
    const path = join(directory, `reference-shots-${randomUUID()}${suffix}`);
    try {
      await pipeline(file.file as unknown as NodeJS.ReadableStream, createWriteStream(path));
      const probe = await probeVideo(path);
      let cuts: number[] = [];
      try {
        const result = await execute(process.env.FFMPEG_PATH ?? "ffmpeg", [
          "-hide_banner", "-nostats", "-i", path,
          "-vf", `scdet=threshold=${CUT_THRESHOLD}`,
          "-an", "-f", "null", "-",
        ], {timeout: 180_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true});
        cuts = parseScdetTimes(String(result.stderr ?? ""));
      } catch (error) {
        // A clip that decodes but trips scdet still yields the cuts it logged.
        const stderr = (error as {stderr?: string | Buffer}).stderr;
        cuts = parseScdetTimes(String(stderr ?? ""));
        if (!cuts.length) throw new HttpError(422, "The clip could not be scanned for shot cuts.");
      }
      const durationSec = Math.round(probe.durationSeconds * 100) / 100;
      return {
        durationSec,
        aspectRatio: Math.round((probe.width / probe.height) * 1000) / 1000,
        cuts: cuts.filter((cut) => cut > 0.2 && cut < durationSec - 0.2),
        shots: shotsFromCuts(durationSec, cuts),
        width: probe.width,
        height: probe.height,
      };
    } finally {
      await unlink(path).catch(() => undefined);
    }
  });
}

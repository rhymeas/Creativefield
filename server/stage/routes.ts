import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { HttpError, member } from "../auth";
import { newId } from "../crypto";
import type { DiskStore } from "../storage";
import { renderBlocking } from "./render";
import { SETS, buildScene, setById } from "./sets";
import { CAMERA_MOVES, STAGE_RATES, STAGE_SECONDS, cameraMove } from "./stage";

const body = z.object({
  projectId: z.uuid(), set: z.string().max(40), move: z.string().max(40),
  seconds: z.number().refine((n) => (STAGE_SECONDS as readonly number[]).includes(n), "Choose 2, 3, 4 or 5 seconds"),
  aspect: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
  // 16 fps feeds Wan VACE; 24 fps feeds MiniMax H3 (Grey-block to video).
  fps: z.number().refine((n) => (STAGE_RATES as readonly number[]).includes(n), "Choose 16 or 24 fps").default(16),
}).strict();

/** One shot is drawn at a time: the rasterizer is CPU-bound and a second request would only slow both. */
let drawing: Promise<unknown> = Promise.resolve();

/**
 * Block a shot: draws a grey-box clip and its depth pass from a ready-made set and a camera move, and stores both
 * as project videos whose size, frame count and timestamps match, ready for the depth restyle (Wan VACE).
 * The rasterizer is ported from OpenField's Stage (MIT); see server/stage/raster.ts.
 */
export async function blockShotRoutes(app: FastifyInstance, pool: Pool, store: DiskStore) {
  const base = "/api/v1/workspaces/:workspaceId", ws = z.object({ workspaceId: z.uuid() });
  app.get(`${base}/block-shot/options`, async (request) => {
    const { workspaceId } = ws.parse(request.params); await member(pool, request, workspaceId);
    return { sets: SETS.map(({ id, name, text }) => ({ id, name, text })), moves: CAMERA_MOVES.map(({ id, name }) => ({ id, name })), seconds: STAGE_SECONDS };
  });
  app.post(`${base}/block-shot`, async (request) => {
    const { workspaceId } = ws.parse(request.params), user = await member(pool, request, workspaceId, "creator");
    const input = body.parse(request.body);
    if (!setById(input.set) || !cameraMove(input.move)) throw new HttpError(422, "Choose a set and a camera move from the list.");
    if (!(await pool.query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2", [workspaceId, input.projectId])).rowCount) throw new HttpError(404, "Project not found.");
    const turn = drawing.catch(() => undefined).then(() => draw());
    drawing = turn;
    return turn;

    async function draw() {
      const dir = path.join(store.root, ".block-shot", newId());
      await mkdir(dir, { recursive: true });
      const saved: Array<{ key: string }> = [];
      try {
        const rendered = await renderBlocking(buildScene(input.set, input.move, input.aspect), input.seconds, dir, undefined, input.fps);
        const label = `${setById(input.set)!.name}, ${cameraMove(input.move)!.name.toLowerCase()}`;
        const out: Record<string, unknown> = {};
        for (const [role, file, name] of [["layout", rendered.clay, `Layout: ${label}`], ["depth", rendered.depth, `Depth: ${label}`]] as const) {
          const put = await store.put(workspaceId, createReadStream(file));
          saved.push(put);
          const id = newId();
          const metadata = { blockShot: { set: input.set, move: input.move, seconds: input.seconds, aspect: input.aspect, role, frames: rendered.frames, fps: rendered.fps, width: rendered.width, height: rendered.height } };
          await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,'video','video/mp4',$5,$6,$7,$8,NULL,$9)", [id, workspaceId, input.projectId, name, put.key, put.sha256, put.bytes, user.id, JSON.stringify(metadata)]);
          out[role] = { id, name, bytes: put.bytes };
        }
        saved.length = 0;
        return { ...out, frames: rendered.frames, width: rendered.width, height: rendered.height, fps: rendered.fps };
      } catch (error) {
        for (const file of saved) await store.remove(workspaceId, file.key).catch(() => undefined);
        throw error;
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });
}

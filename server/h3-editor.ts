import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {execFile} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import {HttpError, member} from "./auth";
import type {DiskStore} from "./storage";

const workspaceParams = z.object({workspaceId: z.uuid()});
const projectParams = z.object({workspaceId: z.uuid(), name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/)});
const noteBody = z.object({
  clip: z.string().trim().min(1).max(200),
  frame: z.number().int().min(0).max(1_000_000),
  text: z.string().trim().min(1).max(4000),
  take: z.string().trim().min(1).max(200).optional(),
}).strict();

const importBody = z.object({
  /** A video or picture asset of this project (a rendered clip, or a still for an animatic). */
  assetId: z.uuid(),
  projectId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  /** The H3 clip it belongs after on the timeline; without it, the clip goes to the end. */
  afterClip: z.string().trim().min(1).max(200).optional(),
  /** A timeline frame to place it at; wins over afterClip. */
  start: z.number().int().min(0).max(1_000_000).optional(),
  /** How long a picture stays on the timeline (an animatic shot). Ignored for video. */
  seconds: z.number().min(0.5).max(60).optional(),
  /** A camera move on a picture (animatic): a slow push-in for a realisation or a decision, a pull-out for scale or a
   *  reveal. The still becomes a short video of exactly `seconds`. Ignored for video. */
  move: z.enum(["push-in", "pull-out"]).optional(),
}).strict();

const replaceBody = z.object({
  /** The video that takes the place of a timeline item, for example the rendered clip of an animatic still. */
  assetId: z.uuid(),
  projectId: z.uuid(),
  /** The timeline item it replaces: its start and length are kept. */
  item: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200).optional(),
  /** trim (default): play at normal speed and cut what does not fit. speed: play the whole clip, faster or slower, so
   *  it ends exactly at the end of the shot (a clip generated from this shot's still to the next shot's still must keep
   *  its last frame, or the hand-over to the next shot jumps). */
  fit: z.enum(["trim", "speed"]).optional(),
}).strict();

const PICTURE_EXTENSIONS: Record<string, string> = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"};

type TimelineItem = {id?: unknown; clip?: unknown; start?: unknown; in?: unknown; out?: unknown; speed?: unknown};

/** The editor operations that put clip `clip` (a fresh import of `frames` frames) where timeline item `itemId` is:
 *  same start, the same length when the new clip is long enough. `short` says the new clip ends before the old item
 *  did, so a gap is left for the caller to see. Undefined when the item is not on the timeline. Pure. */
export function replacementOps(project: {timeline?: unknown}, itemId: string, clip: string, frames: number, fit: "trim" | "speed" = "trim") {
  if (!Array.isArray(project.timeline)) return undefined;
  const item = (project.timeline as TimelineItem[]).find(entry => entry?.id === itemId);
  if (!item) return undefined;
  const speed = Number(item.speed) > 0 ? Number(item.speed) : 1;
  const length = Math.round((Number(item.out) - Number(item.in)) / speed);
  const start = Number(item.start);
  if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(start)) return undefined;
  const whole = Math.max(1, Math.floor(frames));
  const out = fit === "speed" ? whole : Math.min(whole, length);
  const fields = fit === "speed" ? {in: 0, out, speed: +(out / length).toFixed(4)} : {in: 0, out};
  /* Placing a clip longer than the gap makes the editor push every later shot back before the trim (seen 2026-11-24,
     21 frames for one 3.5 s clip). So the clip is placed past the end of the timeline, trimmed there, and only then
     moved into its slot, which it now fits exactly. */
  const end = (project.timeline as TimelineItem[]).reduce((max, entry) => {
    const finish = Number(entry?.start) + (Number(entry?.out) - Number(entry?.in)) / (Number(entry?.speed) > 0 ? Number(entry?.speed) : 1);
    return Number.isFinite(finish) ? Math.max(max, Math.ceil(finish)) : max;
  }, 0);
  return {
    start, length, short: fit === "trim" && out < length,
    ops: [
      {op: "remove_item", item: itemId},
      {op: "place_clip", clip, start: end + 24, as: "placed"},
      {op: "update_item", item: "$placed.item", fields},
      {op: "update_item", item: "$placed.item", fields: {start}},
    ],
  };
}
/** How many frames a still of `seconds` holds on the editor's 24 fps timeline. Pure. */
export function stillFrames(seconds: number) { return Math.max(1, Math.round(seconds * 24)); }
/** The share a still grows by over a camera move: 8 %, enough to feel in an animatic without reading as a zoom. */
export const STILL_MOVE_AMOUNT = 0.08;
/** Extra frame rendered for a moved still: the editor's video import drops one, so the clip lands at exactly the length asked for. More would make the editor push the following shots back (seen 2026-11-24). */
export const STILL_MOVE_SPARE = 1;
/** The ffmpeg filter that turns one still into `frames` frames at 24 fps with a centred push-in (growing by
 *  `amount`) or pull-out (shrinking back from it). The still is enlarged 2x first so the zoom does not step by
 *  whole pixels. Pure. */
export function stillMoveFilter(move: "push-in" | "pull-out", frames: number, width = 1920, height = 1080, amount = STILL_MOVE_AMOUNT) {
  const last = Math.max(1, frames - 1);
  const zoom = move === "push-in" ? `1+${amount}*on/${last}` : `1+${amount}-${amount}*on/${last}`;
  return `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,crop=${width * 2}:${height * 2},`
    + `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=24,format=yuv420p`;
}
const execFileAsync = promisify(execFile);
/** Render a still with a camera move into an mp4 of exactly `frames` frames. */
async function stillMoveVideo(still: Buffer, move: "push-in" | "pull-out", frames: number) {
  const folder = await mkdtemp(join(tmpdir(), "cf-move-"));
  try {
    await writeFile(join(folder, "still"), still);
    await execFileAsync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", join(folder, "still"),
      "-vf", stillMoveFilter(move, frames), "-frames:v", String(frames), "-c:v", "libx264", "-crf", "16", "-preset", "medium", join(folder, "move.mp4")],
    {timeout: 120_000, windowsHide: true});
    return await readFile(join(folder, "move.mp4"));
  } finally { await rm(folder, {recursive: true, force: true}); }
}
/** The timeline frame right after the first placement of a clip, or undefined (the editor then puts
 *  the new clip at the end). The editor moves later clips to make room. Pure. */
export function frameAfter(project: {timeline?: unknown}, clipId: string | undefined): number | undefined {
  if (!clipId || !Array.isArray(project.timeline)) return undefined;
  const placed = (project.timeline as TimelineItem[])
    .filter(item => item?.clip === clipId && Number.isFinite(Number(item.start)) && Number(item.out) > Number(item.in))
    .sort((left, right) => Number(left.start) - Number(right.start))[0];
  return placed ? Number(placed.start) + Number(placed.out) - Number(placed.in) : undefined;
}

/**
 * Pick the local ComfyUI that actually serves the H3 Editor. Several local workers may be
 * registered; only the one answering /h3take/api/projects is the editor's host.
 */
export async function h3WorkerFor(pool: Pool, workspaceId: string) {
  const rows = (await pool.query(
    "SELECT origin FROM workers WHERE workspace_id=$1 AND enabled=true AND kind='local' ORDER BY name,id",
    [workspaceId],
  )).rows as Array<{origin: string}>;
  for (const row of rows) {
    try {
      const probe = await fetch(`${row.origin.replace(/\/+$/, "")}/h3take/api/projects`, {signal: AbortSignal.timeout(4_000)});
      if (probe.ok) return row.origin.replace(/\/+$/, "");
    } catch { /* not the worker that runs the editor */ }
  }
  throw new HttpError(503, "No local worker with the H3 Editor is available");
}

/**
 * The H3 Editor runs as a ComfyUI custom node and keeps its project and media in ComfyUI's
 * output folder. The browser cannot call it directly from CreativeField (cross-origin), so this
 * bridge exposes only the project read, clip bytes and note write that the analysis panel needs.
 * Every route requires current workspace membership and only talks to a local worker.
 */
export async function h3EditorRoutes(app: FastifyInstance, pool: Pool, store: DiskStore) {
  async function workerFor(workspaceId: string) {
    return h3WorkerFor(pool, workspaceId);
  }

  async function workerJson(origin: string, path: string, init?: RequestInit) {
    const response = await fetch(`${origin}${path}`, {...init, signal: AbortSignal.timeout(20_000)});
    const body = await response.text();
    if (!response.ok) throw new HttpError(response.status === 404 ? 404 : 502, body.trim().slice(0, 500) || `H3 Editor answered ${response.status}`);
    try { return JSON.parse(body) as unknown; }
    catch { throw new HttpError(502, "H3 Editor returned an invalid answer"); }
  }

  app.get("/api/v1/workspaces/:workspaceId/h3-editor/project/:name", async request => {
    const {workspaceId, name} = projectParams.parse(request.params);
    await member(pool, request, workspaceId);
    return workerJson(await workerFor(workspaceId), `/h3take/api/project/${encodeURIComponent(name)}`);
  });

  app.get("/api/v1/workspaces/:workspaceId/h3-editor/media", async (request, reply) => {
    const {workspaceId} = workspaceParams.parse(request.params);
    await member(pool, request, workspaceId);
    const query = request.query as {filename?: unknown; subfolder?: unknown};
    const filename = typeof query.filename === "string" ? query.filename : "";
    // The editor writes Windows folders with backslashes for generated takes; ComfyUI reads either.
    const subfolder = typeof query.subfolder === "string" ? query.subfolder.replace(/\\/g, "/") : "";
    if (!filename || filename.includes("/") || filename.includes("\\")) throw new HttpError(400, "Unknown clip");
    /* Only the editor's own project media is readable through this bridge. */
    if (!/^h3take_projects\/[A-Za-z0-9][A-Za-z0-9._-]*(\/|$)/.test(subfolder)) throw new HttpError(403, "Not H3 Editor media");
    const origin = await workerFor(workspaceId);
    const upstream = new URL("/view", origin);
    upstream.searchParams.set("filename", filename);
    upstream.searchParams.set("subfolder", subfolder);
    upstream.searchParams.set("type", "output");
    const response = await fetch(upstream, {signal: AbortSignal.timeout(60_000)});
    if (!response.ok) throw new HttpError(response.status === 404 ? 404 : 502, "The clip is not available");
    const type = response.headers.get("content-type") ?? "application/octet-stream";
    const bytes = Buffer.from(await response.arrayBuffer());
    return reply.header("Cache-Control", "private, max-age=60").type(type).send(bytes);
  });

  app.post("/api/v1/workspaces/:workspaceId/h3-editor/project/:name/notes", async request => {
    const {workspaceId, name} = projectParams.parse(request.params);
    await member(pool, request, workspaceId);
    const body = noteBody.parse(request.body);
    return workerJson(await workerFor(workspaceId), `/h3take/api/project/${encodeURIComponent(name)}/ops`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({ops: [{op: "add_note", fields: body}]}),
    });
  });

  /* Bring a video of this CreativeField project into the H3 project as footage, right after the
     clip it was made from (the Film Studio previs clip). Creator role: it changes the H3 project. */
  app.post("/api/v1/workspaces/:workspaceId/h3-editor/project/:name/import", async request => {
    const {workspaceId, name} = projectParams.parse(request.params);
    await member(pool, request, workspaceId, "creator");
    const body = importBody.parse(request.body);
    const asset = await loadAsset(workspaceId, body.projectId, body.assetId, false);
    const origin = await workerFor(workspaceId);
    const project = await openProject(origin, name);
    const start = body.start ?? frameAfter(project, body.afterClip);
    const result = await importAsset(origin, workspaceId, asset, name, body.name, {place: true, start, seconds: body.seconds, move: body.move});
    return {clip: result.clip, item: result.item ?? null, frames: result.frames ?? 0, start: start ?? null};
  });

  /* Put a video where a timeline item is, keeping its start and length: an animatic still becomes its rendered clip, or a clip becomes its upscaled version, without download and re-import by hand. Creator role. */
  app.post("/api/v1/workspaces/:workspaceId/h3-editor/project/:name/replace", async request => {
    const {workspaceId, name} = projectParams.parse(request.params);
    await member(pool, request, workspaceId, "creator");
    const body = replaceBody.parse(request.body);
    const asset = await loadAsset(workspaceId, body.projectId, body.assetId, true);
    const origin = await workerFor(workspaceId);
    const project = await workerJson(origin, `/h3take/api/project/${encodeURIComponent(name)}`) as {timeline?: unknown};
    if (!replacementOps(project, body.item, "check", 1)) throw new HttpError(404, "That shot is not on the timeline");
    const imported = await importAsset(origin, workspaceId, asset, name, body.name ?? "Clip", {place: false});
    if (!imported.clip) throw new HttpError(502, "The H3 Editor did not make a clip");
    const plan = replacementOps(project, body.item, imported.clip, imported.frames ?? 0, body.fit)!;
    const done = await workerJson(origin, `/h3take/api/project/${encodeURIComponent(name)}/ops`, {
      method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({ops: plan.ops}),
    }) as {results?: Array<{item?: string}>};
    return {clip: imported.clip, item: done.results?.[1]?.item ?? null, start: plan.start, frames: plan.length, short: plan.short};
  });

  /* The project's Film Studio may not exist yet (a new project, or the first clip sent to it): create it, named
     as the Film Studio opens it, instead of refusing the clip. Only this name is created; nothing else changes. */
  async function openProject(origin: string, name: string) {
    return await workerJson(origin, `/h3take/api/project/${encodeURIComponent(name)}`).catch(async error => {
      if (!(error instanceof HttpError) || error.statusCode !== 404) throw error;
      await workerJson(origin, "/h3take/api/projects", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name})});
      return workerJson(origin, `/h3take/api/project/${encodeURIComponent(name)}`);
    }) as {timeline?: unknown};
  }

  type StoredAsset = {storage_key: string; media_type: string; content_type: string | null};
  /** A video (or, unless `videoOnly`, a picture) of this CreativeField project, or a 404/400 before anything changes. */
  async function loadAsset(workspaceId: string, projectId: string, assetId: string, videoOnly: boolean) {
    const asset = (await pool.query("SELECT storage_key,media_type,content_type FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=$3",
      [workspaceId, projectId, assetId])).rows[0] as StoredAsset | undefined;
    if (!asset) throw new HttpError(404, "That clip is not in this project");
    if (asset.media_type !== "video" && (videoOnly || asset.media_type !== "image"))
      throw new HttpError(400, videoOnly ? "Only a video can replace a shot" : "Only a video or a picture can become an H3 clip");
    return asset;
  }

  /** Send one asset to the editor's import. A picture becomes a still clip of `seconds`. */
  async function importAsset(origin: string, workspaceId: string, asset: StoredAsset, project: string, clipName: string,
    options: {place: boolean; start?: number; seconds?: number; move?: "push-in" | "pull-out"}) {
    const bytes = await readFile(await store.file(workspaceId, asset.storage_key));
    /* A camera move turns the still into a video first; the editor then imports footage. Its video import also comes
       out one frame short, so the move runs a few frames longer and the placed item is trimmed to the exact length. */
    const moved = asset.media_type === "image" && options.move && options.seconds !== undefined
      ? await stillMoveVideo(bytes, options.move, stillFrames(options.seconds) + STILL_MOVE_SPARE) : undefined;
    const picture = asset.media_type === "image" && !moved;
    const type = picture ? (PICTURE_EXTENSIONS[asset.content_type ?? ""] ? asset.content_type! : "image/png") : "video/mp4";
    const extension = picture ? PICTURE_EXTENSIONS[type] : ".mp4";
    const form = new FormData();
    form.append("name", clipName);
    form.append("place", String(options.place));
    if (options.start !== undefined) form.append("start", String(options.start));
    /* The editor turns a picture of n frames' seconds into n - 1 frames (ffmpeg -loop -t; measured for 2.2 to 4 s),
       which left a black frame at every cut. Ask for exactly one frame more. Asking for more than that made the editor
       push the following shots back before the trim (seen 2026-11-24). The trim below stays as a safety net. */
    const exact = (picture || moved) && options.seconds !== undefined ? stillFrames(options.seconds) : undefined;
    if (exact !== undefined && picture) form.append("seconds", String(Math.min(60, (exact + 1) / 24)));
    form.append("file", new Blob([moved ?? bytes], {type}), `${picture ? "still" : "clip"}${extension}`);
    const response = await fetch(`${origin}/h3take/api/project/${encodeURIComponent(project)}/import`, {method: "POST", body: form, signal: AbortSignal.timeout(180_000)});
    const text = await response.text();
    if (!response.ok) throw new HttpError(response.status === 404 ? 404 : 502, text.trim().slice(0, 500) || `H3 Editor answered ${response.status}`);
    const imported = JSON.parse(text) as {clip?: string; item?: string | null; frames?: number};
    if (exact !== undefined && options.place && imported.item && (imported.frames ?? 0) > exact) {
      await workerJson(origin, `/h3take/api/project/${encodeURIComponent(project)}/ops`, {
        method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({ops: [{op: "update_item", item: imported.item, fields: {in: 0, out: exact}}]}),
      });
      imported.frames = exact;
    }
    return imported;
  }
}

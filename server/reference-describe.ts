/* The look words a character picture is worth: one short sentence about hair, beard, glasses and
   clothes, written by the local vision model the app already runs on the ComfyUI worker (Qwen3-VL
   through ComfyUI's own TextGenerate node, the same seam server/ai-text/local-comfy.ts uses for text).
   SCAIL-2 re-renders the whole frame from the prompt, so words that say how each person looks are what
   put two pictures on the two right people (docs/TRANSFORM-EVIDENCE.md, "the second person").
   The description is cached per picture, so the same picture costs one model run, not one per pass. */
import {readFile} from "node:fs/promises";
import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {member} from "./auth";
import type {DiskStore} from "./storage";
import type {Worker} from "./ai-text/local-comfy";
import {describeReplacePrompt, lookInstruction, lookWords} from "../src/workflow/reference-prompt";

/** Qwen3-VL on the worker: the vision model ComfyUI loads with CLIPLoader type qwen_image. */
export const VISION_CLIP = "qwen3vl_8b_int8_convrot.safetensors";
const VISION_TYPE = "qwen_image";
const MAX_LOOK_TOKENS = 160;
const LOOK_TIMEOUT_MS = 240_000;

/** ComfyUI reads a picture from its own input folder, so the model gets a LoadImage of it and the
 *  answer comes back through PreviewAny, which is where a TextGenerate result shows up. */
export function visionGraph(picture: string, prompt: string) {
  return {
    "1": {class_type: "CLIPLoader", inputs: {clip_name: VISION_CLIP, type: VISION_TYPE, device: "default"}},
    "2": {class_type: "LoadImage", inputs: {image: picture}},
    "3": {class_type: "TextGenerate", inputs: {clip: ["1", 0], prompt, max_length: MAX_LOOK_TOKENS, sampling_mode: "off", thinking: false, image: ["2", 0]}},
    "4": {class_type: "PreviewAny", inputs: {source: ["3", 0]}},
  };
}

/** One description per picture, per workspace and per worker: the same picture is read once, and one
 *  team's reading (or one worker's answer) never answers for another. */
const looks = new Map<string, string>();
const LOOK_CACHE_LIMIT = 64;

/** The sentence cached for this picture, or undefined when it has not been read yet. */
const lookKey = (worker: Pick<Worker, "origin">, picture: Pick<Picture, "sha256" | "scope">) => `${picture.scope ?? ""}|${worker.origin}|${picture.sha256}`;
export function cachedLook(worker: Pick<Worker, "origin">, picture: Pick<Picture, "sha256" | "scope">): string | undefined {
  return looks.get(lookKey(worker, picture));
}

/** Forget every reading. Only tests and a rebuilt worker inventory need this. */
export function clearLookCache(): void {
  looks.clear();
}

const extension = (mediaType: string) => (mediaType === "image/png" ? "png" : mediaType === "image/webp" ? "webp" : "jpg");

export type Picture = {bytes: Uint8Array; mediaType: string; sha256: string; /** The workspace the picture belongs to. */ scope?: string};

/** Ask the worker's vision model what this picture's person looks like. A worker that cannot read the
 *  picture costs nothing: the caller keeps the words it would have used anyway. */
export async function describePicture(worker: Worker, picture: Picture): Promise<string | undefined> {
  const seen = looks.get(lookKey(worker, picture));
  if (seen) return seen;
  const api = `${worker.origin}${worker.api_prefix ?? ""}`;
  const json = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${api}${path}`, {...init, signal: AbortSignal.timeout(60_000), redirect: "error"});
    if (!response.ok) return null;
    return (await response.json()) as any;
  };
  try {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(picture.bytes)]), `comfyfield-look-${picture.sha256.slice(0, 16)}.${extension(picture.mediaType)}`);
    form.append("overwrite", "true");
    const uploaded = await json("/upload/image", {method: "POST", body: form});
    const name: unknown = uploaded?.name;
    if (typeof name !== "string" || !name) return undefined;
    const queued = await json("/prompt", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({prompt: visionGraph(name, lookInstruction())}),
    });
    const id: unknown = queued?.prompt_id;
    if (typeof id !== "string") return undefined;
    const until = Date.now() + LOOK_TIMEOUT_MS;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const entry = (await json(`/history/${encodeURIComponent(id)}`))?.[id];
      if (entry?.status?.status_str === "error") return undefined;
      const text: unknown = entry?.outputs?.["4"]?.text?.[0];
      const look = typeof text === "string" ? lookWords(text) : undefined;
      if (!look) continue;
      looks.set(lookKey(worker, picture), look);
      while (looks.size > LOOK_CACHE_LIMIT) looks.delete(looks.keys().next().value!);
      return look;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The worker that can read a picture, as reference-plan.ts picks it. */
export async function visionWorker(pool: Pool, workspaceId: string): Promise<Worker | undefined> {
  return (await pool.query("SELECT origin,api_prefix FROM workers WHERE workspace_id=$1 AND enabled=true ORDER BY checked_at DESC NULLS LAST,id LIMIT 1", [workspaceId])).rows[0] as Worker | undefined;
}

const faceSchema = z.object({
  label: z.string().regex(/^@Image \d{1,2}$/),
  assetId: z.uuid(),
  /** Where the person stands, in the words the plan uses ("1st person from the left"). */
  where: z.string().trim().min(1).max(80),
  outfit: z.string().trim().max(300).optional(),
});
const requestSchema = z.object({
  projectId: z.uuid(),
  people: z.array(faceSchema).min(1).max(4),
  scene: z.string().trim().max(2000).optional(),
  keep: z.string().trim().max(300).optional(),
}).strict();

/** Reads each picture once and returns the describing sentence the pass should run on. Nothing is
 *  generated here; a worker that cannot read a picture leaves the prompt out, so the caller keeps
 *  the sentence it would have sent anyway. */
export async function referenceDescribeRoutes(app: FastifyInstance, pool: Pool, store: DiskStore) {
  app.post("/api/v1/workspaces/:workspaceId/reference-describe", async (request) => {
    const {workspaceId} = z.object({workspaceId: z.uuid()}).parse(request.params);
    await member(pool, request, workspaceId, "creator");
    const body = requestSchema.parse(request.body ?? {});
    const worker = await visionWorker(pool, workspaceId);
    const read: Record<string, string> = {};
    for (const person of body.people) {
      const asset = (await pool.query("SELECT storage_key,sha256,content_type FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=$3", [workspaceId, body.projectId, person.assetId])).rows[0];
      if (!worker || !asset) continue;
      const bytes = await readFile(await store.file(workspaceId, asset.storage_key));
      const look = await describePicture(worker, {bytes, mediaType: asset.content_type, sha256: asset.sha256, scope: workspaceId});
      if (look) read[person.label] = look;
    }
    const prompt = describeReplacePrompt({
      people: body.people.map((person) => ({where: person.where, look: read[person.label], outfit: person.outfit})),
      scene: body.scene,
      keep: body.keep,
    });
    return {looks: read, source: Object.keys(read).length ? "local" : "none", prompt};
  });
}

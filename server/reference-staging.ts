/*
 * Fully local staging pass: one still frame per shot is described by a local
 * vision-language model (Qwen3-VL through Ollama), so the studio never needs a
 * cloud provider to build a blockout. The model returns strict JSON per frame;
 * the client turns it into a scene plan.
 *
 * The fast vision decision model (d3) gives an immediate blockout; this slower
 * pass refines cast, framing, lens and movement. Both are local and optional.
 */
import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {HttpError, member} from "./auth";

const IMAGE = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/;
const MAX_FRAMES = 8;
const PROMPT = [
  "You are a film previsualisation supervisor building a grey-block blockout.",
  "Analyse ONE still frame from a shot and return ONLY one JSON object (no markdown) with:",
  '{"shot_size":"wide|medium|close","camera_movement":"static|dolly|pan|handheld","lens_mm":number,"distance_m":number,"people":[{"label":"short role","screen":"left|center|right"}],"description":"one short sentence"}',
  "Rules:",
  "- shot_size: wide shows the room/whole body, medium waist-up, close face/detail.",
  "- camera_movement: only what the framing suggests; use static when in doubt.",
  "- lens_mm: 24-35 for wide, 40-60 medium, 75-100 close; distance_m is camera-to-subject metres.",
  "- people: only people actually visible; empty array when none. screen is where they sit in frame.",
  "- description: what is staged, no story invention.",
].join("\n");

type StagingShot = {
  shot_size: "wide" | "medium" | "close";
  camera_movement: "static" | "dolly" | "pan" | "handheld";
  lens_mm: number;
  distance_m: number;
  people: Array<{label: string; screen: "left" | "center" | "right"}>;
  description: string;
};

const body = z.object({
  frames: z.array(z.string().max(4_000_000)).min(1).max(MAX_FRAMES),
  model: z.string().min(1).max(80).optional(),
}).strict();

const posterBody = z.object({videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/)}).strict();

export async function referenceStagingRoutes(app: FastifyInstance, pool: Pool) {
  app.post("/api/v1/workspaces/:workspaceId/reference-staging", {bodyLimit: 48 * 1024 * 1024}, async (request) => {
    const {workspaceId} = z.object({workspaceId: z.uuid()}).parse(request.params);
    await member(pool, request, workspaceId);
    const input = body.parse(request.body ?? {});
    // Small, reliable default: no generative staging unless the user explicitly enables it.
    if (process.env.LOCAL_STAGING !== "on") throw new HttpError(503, "Local staging is off (small-model mode). The fast vision-decision blockout is used instead.");
    const base = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    const model = await resolveVisionModel(base, input.model);
    const started = Date.now();
    const shots: Array<StagingShot | null> = [];
    for (const frame of input.frames) {
      const match = IMAGE.exec(frame);
      if (!match) throw new HttpError(400, "Staging frames must be jpeg, png or webp data URLs.");
      shots.push(await describeFrame(base, model, match[1]));
    }
    return {model, shots, ms: Date.now() - started};
  });

  // Capabilities let the client skip a staging call that is disabled by default.
  app.get("/api/v1/workspaces/:workspaceId/analysis-capabilities", async (request) => {
    const {workspaceId} = z.object({workspaceId: z.uuid()}).parse(request.params);
    await member(pool, request, workspaceId);
    return {staging: process.env.LOCAL_STAGING === "on", local: true};
  });
  // A YouTube embed exposes no frames; its poster is the one local still we can analyse.
  app.post("/api/v1/workspaces/:workspaceId/youtube-poster", async (request) => {
    const {workspaceId} = z.object({workspaceId: z.uuid()}).parse(request.params);
    await member(pool, request, workspaceId);
    const {videoId} = posterBody.parse(request.body ?? {});
    for (const name of ["maxresdefault", "hqdefault", "mqdefault"]) {
      try {
        const response = await fetch(`https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/${name}.jpg`, {signal: AbortSignal.timeout(15_000), redirect: "error"});
        if (!response.ok) continue;
        const type = (response.headers.get("content-type") ?? "").split(";")[0];
        if (!type.startsWith("image/")) continue;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > 1_500_000) continue;
        return {frame: `data:${type};base64,${bytes.toString("base64")}`};
      } catch {
        // Try the next poster size.
      }
    }
    throw new HttpError(502, "The YouTube poster could not be loaded.");
  });
}

async function resolveVisionModel(base: string, requested?: string): Promise<string> {
  if (requested) return requested;
  if (process.env.LOCAL_VISION_MODEL) return process.env.LOCAL_VISION_MODEL;
  try {
    const response = await fetch(`${base}/api/tags`, {signal: AbortSignal.timeout(3000)});
    if (response.ok) {
      const payload = (await response.json()) as {models?: Array<{name?: string}>};
      const names = (payload.models ?? []).map((entry) => entry.name).filter((name): name is string => typeof name === "string");
      // Prefer non-thinking vision models for a fast, schema-only answer; Qwen3-VL reasons for seconds per frame.
      const preferred = names.find((name) => /^gemma3:(4b|12b|27b)/.test(name)) ?? names.find((name) => /^qwen2\.5vl/.test(name)) ?? names.find((name) => /^qwen3-vl/.test(name));
      if (preferred) return preferred;
    }
  } catch {
    // Fall through to the setup hint.
  }
  throw new HttpError(503, "No local vision model is available. Install Ollama, then run `ollama pull qwen3-vl:4b` and retry.");
}

async function describeFrame(base: string, model: string, image: string): Promise<StagingShot | null> {
  let response: Response;
  try {
    response = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        model,
        messages: [{role: "user", content: PROMPT, images: [image]}],
        stream: false,
        format: "json",
        options: {temperature: 0, num_predict: 400},
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new HttpError(503, "The local vision model is not reachable. Start Ollama and retry.");
  }
  const payload = (await response.json().catch(() => null)) as {message?: {content?: string}; error?: string} | null;
  if (!response.ok || !payload) throw new HttpError(502, payload?.error ?? `The local vision model answered ${response.status}.`);
  return parseStaging(payload.message?.content);
}

/** Tolerant JSON read: the model may wrap the object in prose or fences. */
export function parseStaging(text: string | undefined): StagingShot | null {
  if (!text) return null;
  // Tiny general VLMs sometimes echo the schema instead of analysing the frame; treat that as no answer.
  if (text.includes("wide|medium|close") || text.includes("one short sentence") || text.includes("woman|man|person|child")) return null;
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const candidates = [cleaned, start >= 0 && end > start ? cleaned.slice(start, end + 1) : ""];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as Partial<StagingShot> & {people?: unknown};
      const people = Array.isArray(parsed.people) ? parsed.people.filter((entry): entry is {label: string; screen: "left" | "center" | "right"} => !!entry && typeof entry === "object" && ["left", "center", "right"].includes(String((entry as {screen?: unknown}).screen))).slice(0, 4) : [];
      return {
        shot_size: parsed.shot_size === "wide" || parsed.shot_size === "close" ? parsed.shot_size : "medium",
        camera_movement: parsed.camera_movement === "dolly" || parsed.camera_movement === "pan" || parsed.camera_movement === "handheld" ? parsed.camera_movement : "static",
        lens_mm: Math.max(18, Math.min(135, Number(parsed.lens_mm) || 35)),
        distance_m: Math.max(0.5, Math.min(40, Number(parsed.distance_m) || 4)),
        people: people.map((person) => ({label: genericLabel(String(person.label)), screen: person.screen})),
        description: String(parsed.description ?? "").slice(0, 240),
      };
    } catch {
      // Next candidate.
    }
  }
  return null;
}

/** The model sometimes echoes a placeholder ("short role"); keep a useful name instead. */
function genericLabel(label: string): string {
  const trimmed = label.trim().slice(0, 40);
  if (!trimmed || /^(short role|role|person|actor|character)$/i.test(trimmed)) return "Actor";
  return trimmed;
}

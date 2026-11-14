/*
 * Decision-model proxy: forwards a compact state + typed questions to a local
 * System One server (Kev through Ollama). The studio uses this only for cheap
 * triage; if no model is running the route says exactly what to install and the
 * client keeps its deterministic heuristic.
 */
import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {HttpError, member} from "./auth";

const MAX_STATE = 24_000;
const IMAGE = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/;
const body = z.object({
  state: z.string().min(1).max(MAX_STATE),
  images: z.array(z.string().max(4_000_000)).max(8).optional(),
  questions: z.record(z.string().min(1).max(64), z.record(z.string(), z.unknown())),
  model: z.string().min(1).max(80).optional(),
}).strict().refine((input) => Object.keys(input.questions).length <= 30, {message: "At most 30 questions per decision request"});

/** Ollama takes raw base64 in `images`; the browser sends data URLs. */
export function imagePayload(images: string[] | undefined): string[] | undefined {
  if (!images?.length) return undefined;
  return images.map((image) => {
    const match = IMAGE.exec(image);
    if (!match) throw new HttpError(400, "Decision images must be jpeg, png or webp data URLs.");
    return match[1];
  });
}

export async function decisionRoutes(app: FastifyInstance, pool: Pool) {
  app.post("/api/v1/workspaces/:workspaceId/decision", {bodyLimit: 1024 * 1024}, async (request) => {
    const {workspaceId} = z.object({workspaceId: z.uuid()}).parse(request.params);
    await member(pool, request, workspaceId);
    const input = body.parse(request.body ?? {});
    const images = imagePayload(input.images);
    const base = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    const model = await resolveModel(base, input.model, !!images?.length);
    let response: Response;
    try {
      response = await fetch(`${base}/v1/systemone`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({model, state: input.state, questions: input.questions, ...(images ? {images} : {})}),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new HttpError(503, "The decision model is not running. Install Ollama, then pull a model with `ollama pull kev:0.8b-q8` and retry.");
    }
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !payload) throw new HttpError(502, (payload?.error as string | undefined) ?? `The decision model answered ${response.status}.`);
    return {
      answers: (payload.answers ?? payload) as Record<string, unknown>,
      model: (payload.model as string | undefined) ?? model,
    };
  });
}

/** Pick the installed decision model for the request: d3 for image questions, Kev for text. */
export function pickDecisionModel(names: string[], requested?: string, vision = false): string {
  if (requested) return requested;
  const size = (name: string) => Number(new RegExp(":(\\d+(?:\\.\\d+)?)b").exec(name)?.[1] ?? 99);
  const smallest = (candidates: string[]) => [...candidates].sort((left, right) => size(left) - size(right) || left.length - right.length)[0];
  const candidates = names.filter((name) => /^(d3|kev)(?::|$)/.test(name));
  if (vision) {
    const d3 = candidates.filter((name) => /^d3(?::|$)/.test(name));
    if (d3.length) return smallest(d3);
  }
  const kev = candidates.filter((name) => /^kev(?::|$)/.test(name));
  if (kev.length) return smallest(kev);
  if (candidates.length) return smallest(candidates);
  return vision ? "d3:2b" : "kev";
}

async function resolveModel(base: string, requested: string | undefined, vision: boolean): Promise<string> {
  if (requested) return requested;
  const env = vision ? process.env.DECISION_MODEL ?? process.env.VISION_DECISION_MODEL : process.env.KEV_MODEL ?? process.env.DECISION_MODEL;
  if (env) return env;
  try {
    const response = await fetch(`${base}/api/tags`, {signal: AbortSignal.timeout(3000)});
    if (response.ok) {
      const payload = (await response.json()) as {models?: Array<{name?: string}>};
      const names = (payload.models ?? []).map((entry) => entry.name).filter((name): name is string => typeof name === "string");
      return pickDecisionModel(names, undefined, vision);
    }
  } catch {
    // Fall through to the documented default and let the error explain it.
  }
  return pickDecisionModel([], undefined, vision);
}

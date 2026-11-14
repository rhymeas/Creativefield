import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { member, HttpError } from "./auth";
import { assertWorkerUrl } from "../src/capabilities/policy";

/** One shared prompt expander for every workflow: the small Qwen3.5 9B caption model that already
 *  ships on this machine for FLUX, loaded by the local ComfyUI worker. The app sends the user's
 *  prompt here and writes the returned caption back into the workflow's own prompt control. */
export const PROMPT_EXPANDER_MODEL = "qwen3.5_9b_prompt_upsampler_w4a8.safetensors";
export const PROMPT_EXPANDER_SYSTEM = [
  "You are the prompt expander for a text-to-image model.",
  "Rewrite the user's request into one detailed English caption that the image model reads.",
  "Keep every concrete noun, count, material, colour, pose, camera, direction and requested text exactly as written:",
  "never generalise a specific part into a category word and never drop a part.",
  "You may add only visible supporting detail that does not contradict or replace the request.",
  "Answer with the caption alone: no notes, no quotes, no markdown, no lists.",
].join(" ");

const body = z.object({ prompt: z.string().trim().min(1).max(20000) }).strict();
const params = z.object({ workspaceId: z.uuid() });

type WorkerRow = { name: string; origin: string; inventory?: { models?: Array<{ name?: string; location?: string }> } };

function expanderWorker(rows: WorkerRow[]): WorkerRow | undefined {
  return rows.find((row) => Array.isArray(row.inventory?.models)
    && row.inventory.models.some((model) => model.name === PROMPT_EXPANDER_MODEL));
}

/** The model list in the worker row only covers workflows' required models, so a shared prompt
 *  expander may be installed but absent from the inventory. Ask the worker's own loader list. */
async function workerWithModel(rows: WorkerRow[]): Promise<{ row: WorkerRow; origin: string } | undefined> {
  const known = expanderWorker(rows);
  const preferred = (row: WorkerRow) => (/\(H3\)/i.test(row.name) ? 0 : known === row ? 1 : 2);
  const ordered = [...rows].sort((a, b) => preferred(a) - preferred(b));
  for (const row of ordered) {
    if (row === known) {
      try { return { row, origin: assertWorkerUrl(row.origin).origin }; } catch { continue; }
    }
    let origin: string;
    try { origin = assertWorkerUrl(row.origin).origin; } catch { continue; }
    try {
      const answer = await fetch(`${origin}/object_info/CLIPLoader`, { signal: AbortSignal.timeout(5000) });
      if (!answer.ok) continue;
      const info = await answer.json() as { CLIPLoader?: { input?: { required?: { clip_name?: [unknown] } } } };
      const names = info.CLIPLoader?.input?.required?.clip_name?.[0];
      if (Array.isArray(names) && names.includes(PROMPT_EXPANDER_MODEL)) return { row, origin };
    } catch { /* try the next worker */ }
  }
  return undefined;
}

function graph(prompt: string) {
  return {
    "1": { class_type: "CLIPLoader", inputs: { clip_name: PROMPT_EXPANDER_MODEL, type: "flux3", device: "default" } },
    "2": {
      class_type: "TextGenerate",
      inputs: {
        clip: ["1", 0],
        prompt,
        system_prompt: PROMPT_EXPANDER_SYSTEM,
        max_length: 2048,
        sampling_mode: "on",
        "sampling_mode.temperature": 0.7,
        "sampling_mode.top_k": 40,
        "sampling_mode.top_p": 0.95,
        "sampling_mode.min_p": 0,
        "sampling_mode.repetition_penalty": 1.05,
        "sampling_mode.seed": Math.floor(Math.random() * 2147483647),
        "sampling_mode.presence_penalty": 1,
        thinking: false,
        use_default_template: true,
        mtp: "off",
      },
    },
    "3": { class_type: "PreviewAny", inputs: { source: ["2", 0] } },
  };
}

function textOf(entry: unknown): string | undefined {
  const outputs = (entry as { outputs?: Record<string, { text?: unknown }> } | undefined)?.outputs;
  for (const node of Object.values(outputs ?? {})) {
    const value = node?.text;
    if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) return value[0].trim();
  }
  return undefined;
}

async function expand(origin: string, prompt: string, timeoutMs = 120000): Promise<{ text: string; seconds: number }> {
  const started = Date.now();
  const submit = await fetch(`${origin}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: graph(prompt), client_id: "comfyfield-prompt-expander" }),
  });
  const submitted = await submit.json().catch(() => ({})) as { prompt_id?: string; error?: { message?: string } };
  if (!submit.ok || !submitted.prompt_id) throw new HttpError(502, `The prompt expander worker rejected the request${submitted.error?.message ? `: ${submitted.error.message}` : "."}`);
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const history = await fetch(`${origin}/history/${encodeURIComponent(submitted.prompt_id)}`);
    if (!history.ok) continue;
    const entry = (await history.json() as Record<string, unknown>)[submitted.prompt_id];
    if (!entry) continue;
    const text = textOf(entry);
    if (text) return { text, seconds: Number(((Date.now() - started) / 1000).toFixed(1)) };
    const status = (entry as { status?: { status_str?: string } }).status;
    if (status?.status_str === "error") throw new HttpError(502, "The prompt expander could not write a caption.");
  }
  throw new HttpError(504, "The prompt expander took too long; try again.");
}

/** Mount the one shared prompt expander route. */
export async function promptExpanderRoutes(app: FastifyInstance, pool: Pool) {
  app.post("/api/v1/workspaces/:workspaceId/prompt-expand", async (request) => {
    const { workspaceId } = params.parse(request.params);
    const user = await member(pool, request, workspaceId);
    if (!user) throw new HttpError(403, "Workspace membership is required.");
    const { prompt } = body.parse(request.body);
    const workers = (await pool.query(
      "SELECT name,origin,inventory FROM workers WHERE workspace_id=$1 AND enabled=true AND kind='local' ORDER BY name",
      [workspaceId],
    )).rows as WorkerRow[];
    const found = await workerWithModel(workers);
    if (!found) throw new HttpError(422, `No worker has the shared prompt expander (${PROMPT_EXPANDER_MODEL}) installed.`);
    const expanded = await expand(found.origin, prompt);
    return { text: expanded.text, model: PROMPT_EXPANDER_MODEL, worker: found.row.name, seconds: expanded.seconds };
  });
}

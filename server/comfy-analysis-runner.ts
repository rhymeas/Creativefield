/*
 * Minimal, dependency-free client for a local ComfyUI HTTP API, used by the
 * film-studio analysis stages (geometry, persons).
 *
 * It only uses the built-in fetch/FormData/Blob of Node 22 and has no project
 * dependencies, so the pure request/response parsing below is unit-testable with
 * a fake fetch. The origin comes from COMFYFIELD_ANALYSIS_COMFY_ORIGIN and
 * defaults to the local Qwen portable worker on http://127.0.0.1:8188.
 *
 * Batching contract: submit every prompt of a batch first, then poll.
 * ComfyUI serialises the GPU work itself, so this keeps the GPU busy instead of
 * paying one round-trip of latency per shot.
 */
import type {ApiGraph} from "../src/workflow/build";
import type {ShotGeometry} from "../src/film-studio/analysis-contract";

export const DEFAULT_COMFY_ORIGIN = "http://127.0.0.1:8188";
/** How long a batch may wait for all of its prompts. */
export const DEFAULT_BATCH_TIMEOUT_MS = 180_000;
export const DEFAULT_POLL_INTERVAL_MS = 250;

export function comfyOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.COMFYFIELD_ANALYSIS_COMFY_ORIGIN || env.COMFY_ORIGIN || DEFAULT_COMFY_ORIGIN;
  return raw.trim().replace(/\/+$/, "");
}

/** One file ComfyUI wrote for an output node (as returned by /history and /view). */
export type ComfyOutputFile = {filename: string; subfolder: string; type: string};

export type ComfyPromptStatus = "pending" | "completed" | "failed";

export type ComfyPromptExecution = {
  promptId: string;
  status: ComfyPromptStatus;
  /** Output files by node id, in the node's saved order. */
  outputs: Record<string, ComfyOutputFile[]>;
  /** ComfyUI's own execution wall time (execution_start -> execution_success), when reported. */
  durationMs?: number;
  /** Failure message from the history status messages, when failed. */
  message?: string;
};

export type QueueState = {running: string[]; pending: string[]};

export type ComfyClientOptions = {
  origin?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Sleep hook, injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  clientId?: string;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Flatten one output node's value (e.g. SaveImage's `images`, SaveGLB's `3d`) into saved files. */
export function filesOfNodeOutput(output: unknown): ComfyOutputFile[] {
  const record = asRecord(output);
  if (!record) return [];
  const files: ComfyOutputFile[] = [];
  for (const value of Object.values(record)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const file = asRecord(entry);
      if (!file) continue;
      const filename = asString(file.filename);
      if (!filename) continue;
      files.push({filename, subfolder: asString(file.subfolder) ?? "", type: asString(file.type) ?? "output"});
    }
  }
  return files;
}

/** Parse one /history/{promptId} entry (the value) into our execution result. */
export function parseHistoryEntry(promptId: string, entry: unknown): ComfyPromptExecution {
  const record = asRecord(entry);
  if (!record || Object.keys(record).length === 0) return {promptId, status: "pending", outputs: {}};
  const status = asRecord(record.status);
  const completed = status?.completed === true || status?.status_str === "success";
  const statusStr = asString(status?.status_str);
  const durationMs = durationFromMessages(status?.messages);
  const outputs: Record<string, ComfyOutputFile[]> = {};
  for (const [nodeId, output] of Object.entries(asRecord(record.outputs) ?? {})) {
    const files = filesOfNodeOutput(output);
    if (files.length) outputs[nodeId] = files;
  }
  if (completed) return {promptId, status: "completed", outputs, durationMs};
  if (statusStr === "error" || status?.completed === false) {
    return {promptId, status: "failed", outputs, durationMs, message: historyMessage(record, status)};
  }
  // A history entry that only has the prompt (no status yet) is still running.
  return {promptId, status: "pending", outputs};
}

/** ComfyUI reports execution_start / execution_success with millisecond timestamps. */
function durationFromMessages(messages: unknown): number | undefined {
  if (!Array.isArray(messages)) return undefined;
  let start: number | undefined;
  let end: number | undefined;
  for (const message of messages) {
    const pair = Array.isArray(message) ? message : undefined;
    const name = pair?.[0];
    const data = asRecord(pair?.[1]);
    const timestamp = typeof data?.timestamp === "number" ? data.timestamp : undefined;
    if (timestamp === undefined) continue;
    if (name === "execution_start") start = timestamp;
    else if (name === "execution_success" || name === "execution_error") end = timestamp;
  }
  if (start === undefined || end === undefined || end < start) return undefined;
  return end - start;
}

function historyMessage(record: Record<string, unknown>, status: Record<string, unknown> | undefined): string {
  const messages = status?.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const pair = Array.isArray(message) ? message : undefined;
      const detail = asRecord(pair?.[1]);
      if (pair?.[0] === "execution_error") {
        const text = [asString(detail?.exception_type), asString(detail?.exception_message)].filter(Boolean).join(": ");
        if (text) return text;
      }
    }
  }
  const promptError = asRecord(record.prompt_error ?? record.error);
  return asString(promptError?.message) ?? "ComfyUI prompt failed";
}

/** Parse POST /queue state into prompt ids (running first, then pending). */
export function parseQueueState(json: unknown): QueueState {
  const record = asRecord(json);
  const ids = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.map((entry) => (Array.isArray(entry) ? asString(entry[1]) : asString(asRecord(entry)?.prompt_id))).filter((id): id is string => !!id);
  };
  return {running: ids(record?.queue_running), pending: ids(record?.queue_pending)};
}

/** Parse POST /prompt: the prompt id, or a readable error including node errors. */
export function parsePromptSubmission(json: unknown): {promptId: string; error?: undefined} | {promptId?: undefined; error: string} {
  const record = asRecord(json);
  const promptId = asString(record?.prompt_id);
  if (promptId) return {promptId};
  const error = asRecord(record?.error);
  const nodeErrors = asRecord(record?.node_errors);
  const parts: string[] = [];
  if (error) parts.push([asString(error.type), asString(error.message)].filter(Boolean).join(": "));
  for (const [nodeId, entry] of Object.entries(nodeErrors ?? {})) {
    const nodeRecord = asRecord(entry);
    const errors = nodeRecord?.errors;
    if (!Array.isArray(errors)) continue;
    for (const nodeError of errors) {
      const errorRecord = asRecord(nodeError);
      const text = [asString(errorRecord?.message), asString(errorRecord?.details)].filter(Boolean).join(" — ");
      if (text) parts.push(`${nodeId}: ${text}`);
    }
  }
  return {error: parts.filter(Boolean).join("; ") || "ComfyUI rejected the prompt"};
}

/** Build the JSON body of POST /prompt. */
export function promptSubmissionBody(graph: ApiGraph, clientId?: string): Record<string, unknown> {
  return {prompt: graph, client_id: clientId ?? "comfyfield-analysis"};
}

/** A /system_stats answer reduced to what the stages care about. */
export type SystemStats = {online: boolean; comfyuiVersion?: string; devices: Array<{name: string; vramTotal: number; vramFree: number}>};

export function parseSystemStats(json: unknown): SystemStats {
  const record = asRecord(json);
  const system = asRecord(record?.system);
  const devices = Array.isArray(record?.devices) ? record.devices : [];
  return {
    online: !!record,
    comfyuiVersion: asString(system?.comfyui_version),
    devices: devices.flatMap((device) => {
      const entry = asRecord(device);
      const name = asString(entry?.name);
      if (!name) return [];
      return [{name, vramTotal: Number(entry?.vram_total ?? 0), vramFree: Number(entry?.vram_free ?? 0)}];
    }),
  };
}

export class ComfyAnalysisClient {
  readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clientId: string;

  constructor(options: ComfyClientOptions = {}) {
    this.origin = (options.origin ?? comfyOrigin()).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.clientId = options.clientId ?? "comfyfield-analysis";
  }

  private async json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(`${this.origin}${path}`, init);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`ComfyUI ${path} returned ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
    }
    return response.json();
  }

  async systemStats(): Promise<SystemStats> {
    return parseSystemStats(await this.json("/system_stats"));
  }

  /** Node availability from /object_info; returns the missing classes ([] = ready). */
  async missingNodes(classes: string[]): Promise<string[]> {
    const info = asRecord(await this.json("/object_info"));
    if (!info) return classes;
    return classes.filter((name) => !(name in info));
  }

  async queueState(): Promise<QueueState> {
    return parseQueueState(await this.json("/queue"));
  }

  /** POST /prompt. Throws with the node errors when ComfyUI rejects the graph. */
  async submit(graph: ApiGraph): Promise<string> {
    const answer = parsePromptSubmission(
      await this.json("/prompt", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(promptSubmissionBody(graph, this.clientId)),
      }),
    );
    if (answer.error !== undefined) throw new Error(answer.error);
    return answer.promptId;
  }

  /** Submit all prompts of a batch before any polling starts. */
  async submitAll(graphs: ApiGraph[]): Promise<string[]> {
    const promptIds: string[] = [];
    for (const graph of graphs) promptIds.push(await this.submit(graph));
    return promptIds;
  }

  /** One /history/{id} read; null while ComfyUI has no entry for the prompt yet. */
  async history(promptId: string): Promise<ComfyPromptExecution> {
    const json = await this.json(`/history/${encodeURIComponent(promptId)}`);
    const entry = asRecord(json)?.[promptId];
    return parseHistoryEntry(promptId, entry);
  }

  /**
   * Poll until every prompt has a history entry (or the timeout/cancel fires).
   * Returns the executions in the input order; failed prompts carry a message.
   */
  async waitAll(promptIds: string[], options: {timeoutMs?: number; signal?: AbortSignal} = {}): Promise<ComfyPromptExecution[]> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const results = new Map<string, ComfyPromptExecution>();
    let remaining = promptIds.filter((id) => !results.has(id));
    while (remaining.length) {
      if (options.signal?.aborted) {
        await this.cancel(remaining);
        throw new Error("Geometry batch cancelled");
      }
      for (const promptId of remaining) {
        const execution = await this.history(promptId);
        if (execution.status !== "pending") results.set(promptId, execution);
      }
      remaining = promptIds.filter((id) => !results.has(id));
      if (!remaining.length) break;
      if (Date.now() >= deadline) {
        await this.cancel(remaining);
        throw new Error(`ComfyUI batch timed out after ${Math.round(timeoutMs / 1000)} s; ${remaining.length} prompt(s) still pending`);
      }
      await this.sleep(this.pollIntervalMs);
    }
    return promptIds.map((id) => results.get(id)!);
  }

  /** Cancel pending prompts (and interrupt the running one so the GPU frees for the next batch). */
  async cancel(promptIds: string[]): Promise<void> {
    if (!promptIds.length) return;
    await this.json("/queue", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({delete: promptIds}),
    }).catch(() => undefined);
    await this.json("/interrupt", {method: "POST", headers: {"content-type": "application/json"}, body: "{}"}).catch(() => undefined);
  }

  /** Download one saved file from /view. */
  async download(file: ComfyOutputFile): Promise<Buffer> {
    const query = new URLSearchParams({filename: file.filename, subfolder: file.subfolder, type: file.type});
    const response = await this.fetchImpl(`${this.origin}/view?${query.toString()}`);
    if (!response.ok) throw new Error(`ComfyUI /view returned ${response.status} for ${file.filename}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /** Upload a file into ComfyUI's input directory; returns the file name the graph must reference. */
  async upload(filename: string, bytes: Uint8Array, contentType = "application/octet-stream"): Promise<string> {
    const form = new FormData();
    form.append("image", new Blob([bytes], {type: contentType}), filename);
    form.append("type", "input");
    form.append("overwrite", "true");
    const json = asRecord(await this.json("/upload/image", {method: "POST", body: form}));
    const name = asString(json?.name);
    if (!name) throw new Error(`ComfyUI upload of ${filename} returned no file name`);
    return name;
  }
}

/** The persisted files a stage needs from one output node, by extension. */
export function filesWithExtension(files: ComfyOutputFile[], extension: string): ComfyOutputFile[] {
  const suffix = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
  return files.filter((file) => file.filename.toLowerCase().endsWith(suffix));
}

/** Marker used by tests and callers that only need the contracts. */
export type GeometrySource = ShotGeometry["source"];

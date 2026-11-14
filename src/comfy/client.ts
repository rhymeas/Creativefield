import type { ApiGraph } from "../workflow/build";
import type { ObjectInfo } from "../workflow/ui-to-api";

// Routes were confirmed against ComfyUI 0.37 with `npm run smoke`.

/** One validation problem ComfyUI reports for a node input. */
export type NodeError = {
  type: string; // e.g. "value_not_in_list", "required_input_missing"
  message: string;
  details?: string;
  extra_info?: { input_name?: string; received_value?: unknown };
};

/** The body ComfyUI returns when it refuses a prompt (HTTP 400). */
export type PromptRejection = {
  error?: { type?: string; message?: string; details?: string };
  node_errors: Record<string, { errors: NodeError[]; class_type?: string }>;
};

export class PromptRejectedError extends Error {
  constructor(
    readonly rejection: PromptRejection,
    readonly status: number,
  ) {
    super(rejection.error?.message ?? `ComfyUI rejected the prompt (HTTP ${status})`);
    this.name = "PromptRejectedError";
  }
}

export type OutputFile = { filename: string; subfolder: string; type: string };

/** A queue entry: [priority, prompt id, API graph, extra data, output node ids]. */
export type RawQueueItem = [number, string, ApiGraph, { create_time?: number; client_id?: string; studio?: unknown }, string[]];

export type HistoryEntry = {
  /** Same tuple as a queue entry. Present on /history responses; the job's graph and creation time live here. */
  prompt?: RawQueueItem;
  outputs: Record<string, Record<string, unknown>>;
  status?: { status_str?: string; completed?: boolean; messages?: Array<[string, Record<string, unknown>]> };
};

export type RawQueue = { queue_running: RawQueueItem[]; queue_pending: RawQueueItem[] };

export type ComfyEvent =
  | { type: "progress"; value: number; max: number; node: string | null; promptId?: string }
  | { type: "executing"; node: string | null; promptId?: string }
  | { type: "executed"; node: string; promptId?: string; output: Record<string, unknown> }
  | { type: "execution_error"; promptId?: string; nodeId?: string; message: string }
  | { type: "interrupted"; promptId?: string };

/**
 * A client ID that survives page reloads. ComfyUI sends a job's progress messages to the
 * client ID that queued it, so a reloaded page with the same ID keeps receiving them.
 */
export function stableClientId(): string {
  const key = "video-studio.clientId";
  try {
    const saved = localStorage.getItem(key);
    if (saved) return saved;
    const fresh = crypto.randomUUID();
    localStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID(); // storage blocked: progress will not resume after a reload
  }
}

export class ComfyClient {
  /**
   * Base path, e.g. "/comfy" through the Vite proxy, or "http://host:8188" directly.
   * apiPrefix is "/api" on ComfyUI 0.37 (confirmed by `npm run smoke`); the WebSocket stays at /ws.
   */
  constructor(
    private base: string,
    readonly clientId: string = crypto.randomUUID(),
    private apiPrefix: "/api" | "" = "/api",
  ) {}

  private url(path: string): string {
    return `${this.base}${this.apiPrefix}${path}`;
  }

  /**
   * Uploads into ComfyUI's input folder under a unique name, so a later upload can never
   * replace the start image that an earlier job in the history still points at.
   */
  async uploadImage(file: File): Promise<string> {
    const form = new FormData();
    const unique = `studio-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}-${file.name.replace(/[^\w.-]+/g, "_")}`;
    form.append("image", file, unique);
    form.append("overwrite", "false");
    const res = await fetch(this.url("/upload/image"), { method: "POST", body: form });
    if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`);
    const data = (await res.json()) as { name: string; subfolder?: string };
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
  }

  /**
   * Queues a graph. `extraData` is stored with the job and comes back in the history, so the studio
   * can attach what the graph alone does not say (for example which clip an upscale came from).
   */
  async submitPrompt(graph: ApiGraph, extraData?: Record<string, unknown>): Promise<string> {
    const res = await fetch(this.url("/prompt"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: this.clientId, ...(extraData ? { extra_data: extraData } : {}) }),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<PromptRejection> & { prompt_id?: string };
    if (!res.ok || !data.prompt_id) {
      throw new PromptRejectedError({ error: data.error, node_errors: data.node_errors ?? {} }, res.status);
    }
    return data.prompt_id;
  }

  /**
   * Node definitions for just the given classes (a few KB), instead of the full ~1.8 MB object_info.
   * A class the server does not have is simply absent from the result.
   */
  async objectInfoFor(classes: string[]): Promise<ObjectInfo> {
    const parts = await Promise.all(
      [...new Set(classes)].map(async (cls) => {
        const res = await fetch(this.url(`/object_info/${encodeURIComponent(cls)}`), { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`object_info/${cls}: HTTP ${res.status}`);
        return (await res.json()) as ObjectInfo;
      }),
    );
    return Object.assign({}, ...parts) as ObjectInfo;
  }

  async history(promptId: string): Promise<HistoryEntry | undefined> {
    const res = await fetch(this.url(`/history/${promptId}`));
    if (!res.ok) throw new Error(`History failed: HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, HistoryEntry>;
    return data[promptId];
  }

  /** Finished jobs, newest first. Each entry carries the job's graph and creation time. */
  async listHistory(maxItems: number, offset = 0): Promise<Record<string, HistoryEntry>> {
    const res = await fetch(this.url(`/history?max_items=${maxItems}&offset=${offset}`), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`History failed: HTTP ${res.status}`);
    return (await res.json()) as Record<string, HistoryEntry>;
  }

  /** Running and pending jobs. Pending jobs are in the order they will run. */
  async queue(): Promise<RawQueue> {
    const res = await fetch(this.url("/queue"), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Queue failed: HTTP ${res.status}`);
    return (await res.json()) as RawQueue;
  }

  /**
   * Cancels one job whatever its state: a running job is interrupted, a pending job is removed.
   * Returns false when the job had already finished or is unknown.
   */
  async cancelJob(promptId: string): Promise<boolean> {
    const res = await fetch(this.url(`/jobs/${encodeURIComponent(promptId)}/cancel`), { method: "POST" });
    if (!res.ok) throw new Error(`Cancel failed: HTTP ${res.status}`);
    return ((await res.json()) as { cancelled?: boolean }).cancelled === true;
  }

  async interrupt(): Promise<void> {
    await fetch(this.url("/interrupt"), { method: "POST" });
  }

  viewUrl(file: OutputFile): string {
    const q = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder,
      type: file.type,
    });
    return this.url(`/view?${q.toString()}`);
  }

  /** Opens the progress socket. Returns a function that closes it. */
  connect(onEvent: (e: ComfyEvent) => void, onState: (open: boolean) => void): () => void {
    const wsBase = this.base.startsWith("http")
      ? this.base.replace(/^http/, "ws")
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${this.base}`;
    let ws: WebSocket;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    // Reconnect every few seconds, so the UI recovers when ComfyUI starts later.
    const open = () => {
      ws = new WebSocket(`${wsBase}/ws?clientId=${this.clientId}`);
      ws.onopen = () => onState(true);
      ws.onclose = () => {
        onState(false);
        if (!stopped) retry = setTimeout(open, 3000);
      };
      ws.onmessage = onMessage;
    };

    const onMessage = (msg: MessageEvent) => {
      if (typeof msg.data !== "string") return; // binary preview frames are ignored in M2
      const parsed = JSON.parse(msg.data) as { type: string; data: Record<string, unknown> };
      const d = parsed.data as Record<string, any>;
      switch (parsed.type) {
        case "progress":
          onEvent({ type: "progress", value: d.value, max: d.max, node: d.node ?? null, promptId: d.prompt_id });
          break;
        case "executing":
          onEvent({ type: "executing", node: d.node ?? null, promptId: d.prompt_id });
          break;
        case "executed":
          onEvent({ type: "executed", node: d.node, promptId: d.prompt_id, output: d.output ?? {} });
          break;
        case "execution_error":
          onEvent({
            type: "execution_error",
            promptId: d.prompt_id,
            nodeId: d.node_id,
            message: d.exception_message ?? "Execution failed",
          });
          break;
        case "execution_interrupted":
          onEvent({ type: "interrupted", promptId: d.prompt_id });
          break;
      }
    };

    open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws.close();
    };
  }
}

/** Finds the first saved file in a node's history output, whatever key ComfyUI used. */
export function firstOutputFile(outputs: Record<string, unknown> | undefined): OutputFile | undefined {
  if (!outputs) return undefined;
  for (const value of Object.values(outputs)) {
    if (Array.isArray(value)) {
      const hit = value.find(
        (f): f is Partial<OutputFile> & { filename: string } =>
          typeof f === "object" && f !== null && "filename" in f,
      );
      if (hit) {
        return { filename: hit.filename, subfolder: hit.subfolder ?? "", type: hit.type ?? "output" };
      }
    }
  }
  return undefined;
}

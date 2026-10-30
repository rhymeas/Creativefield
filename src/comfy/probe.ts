// Capability probe for a ComfyUI server. Used by scripts/comfy-smoke.ts now,
// and later by the model picker to decide which providers are runnable.
// It only makes harmless calls: reads, one temp-file upload, one invalid prompt.

export type CheckResult = {
  id: string;
  label: string;
  ok: boolean;
  required: boolean;
  detail: string;
};

export type ProbeReport = {
  base: string;
  apiPrefix: "/api" | "";
  version?: string;
  gpu?: { name: string; vramTotalGB: number; vramFreeGB: number };
  checks: CheckResult[];
  missingNodes: string[];
  ok: boolean;
};

/** Node classes the first video pipelines need. A missing one means "not runnable here". */
export const REQUIRED_NODES = [
  "LoadImage",
  "CLIPTextEncode",
  "KSampler",
  "VAEDecode",
  "SaveVideo",
  "CreateVideo",
  "WanImageToVideo",
  "Wan22ImageToVideoLatent",
  "WanFirstLastFrameToVideo",
  "WanAnimateToVideo",
  "LoadVideo",
];

// 1x1 transparent PNG.
const PNG_1X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

type Json = Record<string, any>;

async function getJson(url: string, ms = 10000): Promise<{ status: number; body?: Json }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  const body = (await res.json().catch(() => undefined)) as Json | undefined;
  return { status: res.status, body };
}

export async function probe(base: string): Promise<ProbeReport> {
  const checks: CheckResult[] = [];
  const add = (c: CheckResult) => checks.push(c);
  const report: ProbeReport = { base, apiPrefix: "/api", checks, missingNodes: [], ok: false };

  // 1. Server reachable, and which prefix works. /api is preferred (it matches the shipped OpenAPI spec).
  let prefix: "/api" | "" | null = null;
  for (const p of ["/api", ""] as const) {
    try {
      const r = await getJson(`${base}${p}/system_stats`);
      if (r.status === 200 && r.body?.system) {
        prefix = p;
        report.version = r.body.system.comfyui_version;
        const dev = r.body.devices?.[0];
        if (dev) {
          report.gpu = {
            name: String(dev.name).split(" : ")[0].replace(/^cuda:\d+\s+/, ""),
            vramTotalGB: +(dev.vram_total / 1024 ** 3).toFixed(1),
            vramFreeGB: +(dev.vram_free / 1024 ** 3).toFixed(1),
          };
        }
        break;
      }
    } catch {
      /* try next prefix */
    }
  }
  if (prefix === null) {
    add({ id: "reach", label: "Server reachable", ok: false, required: true, detail: `no answer from ${base}` });
    return report;
  }
  report.apiPrefix = prefix;
  add({
    id: "reach",
    label: "Server reachable",
    ok: true,
    required: true,
    detail: `ComfyUI ${report.version}, route prefix "${prefix || "(none)"}"`,
  });
  const api = `${base}${prefix}`;

  // 2. Read-only routes the client uses.
  for (const [id, path, required] of [
    ["queue", "/queue", true],
    ["history", "/history", true],
    ["object_info", "/object_info", true],
    ["jobs", "/jobs", false],
    ["features", "/features", false],
  ] as const) {
    try {
      const r = await getJson(`${api}${path}`, 30000);
      add({ id, label: `GET ${path}`, ok: r.status === 200, required, detail: `HTTP ${r.status}` });
    } catch (e) {
      add({ id, label: `GET ${path}`, ok: false, required, detail: (e as Error).message });
    }
  }

  // 3. Node classes the pipelines need.
  try {
    const info = (await getJson(`${api}/object_info`, 30000)).body ?? {};
    report.missingNodes = REQUIRED_NODES.filter((n) => !(n in info));
    add({
      id: "nodes",
      label: "Video node classes present",
      ok: report.missingNodes.length === 0,
      required: true,
      detail:
        report.missingNodes.length === 0
          ? `${REQUIRED_NODES.length} of ${REQUIRED_NODES.length} found (${Object.keys(info).length} classes total)`
          : `missing: ${report.missingNodes.join(", ")}`,
    });
  } catch (e) {
    add({ id: "nodes", label: "Video node classes present", ok: false, required: true, detail: (e as Error).message });
  }

  // 4. WebSocket: the server sends a status message on connect.
  add(await checkWebSocket(base, prefix));

  // 5. Upload a tiny image to the temp folder and read it back through /view.
  try {
    const form = new FormData();
    form.append("image", new Blob([PNG_1X1], { type: "image/png" }), "studio-smoke.png");
    form.append("type", "temp");
    form.append("overwrite", "true");
    const up = await fetch(`${api}/upload/image`, { method: "POST", body: form, signal: AbortSignal.timeout(10000) });
    const upBody = (await up.json().catch(() => ({}))) as Json;
    if (!up.ok || !upBody.name) {
      add({ id: "upload", label: "POST /upload/image", ok: false, required: true, detail: `HTTP ${up.status}` });
    } else {
      const q = new URLSearchParams({ filename: upBody.name, subfolder: upBody.subfolder ?? "", type: upBody.type ?? "temp" });
      const view = await fetch(`${api}/view?${q}`, { signal: AbortSignal.timeout(10000) });
      const bytes = new Uint8Array(await view.arrayBuffer());
      add({
        id: "upload",
        label: "Upload then /view round trip",
        ok: view.ok && bytes.length > 0,
        required: true,
        detail: `uploaded ${upBody.name}, read back ${bytes.length} bytes (HTTP ${view.status})`,
      });
    }
  } catch (e) {
    add({ id: "upload", label: "Upload then /view round trip", ok: false, required: true, detail: (e as Error).message });
  }

  // 6. Error shape: an invalid graph must be rejected with a readable error, and nothing is queued.
  try {
    const res = await fetch(`${api}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: { "1": { class_type: "NoSuchNode", inputs: {} } }, client_id: "studio-smoke" }),
      signal: AbortSignal.timeout(10000),
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    const hasError = res.status === 400 && (body.error || body.node_errors);
    add({
      id: "prompt_error",
      label: "Invalid prompt is rejected with an error",
      ok: !!hasError,
      required: true,
      detail: hasError
        ? `HTTP 400, error type "${body.error?.type ?? "n/a"}", ${Object.keys(body.node_errors ?? {}).length} node error(s)`
        : `HTTP ${res.status}`,
    });
  } catch (e) {
    add({ id: "prompt_error", label: "Invalid prompt is rejected with an error", ok: false, required: true, detail: (e as Error).message });
  }

  report.ok = checks.every((c) => c.ok || !c.required);
  return report;
}

function checkWebSocket(base: string, prefix: string): Promise<CheckResult> {
  const id = "ws";
  const label = "WebSocket /ws";
  return new Promise((resolve) => {
    const clientId = crypto.randomUUID();
    const url = `${base.replace(/^http/, "ws")}/ws?clientId=${clientId}`;
    let done = false;
    const finish = (r: Omit<CheckResult, "id" | "label" | "required">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({ id, label, required: true, ...r });
    };
    const ws = new WebSocket(url);
    const timer = setTimeout(() => finish({ ok: false, detail: "no status message within 5 s" }), 5000);
    ws.onerror = () => finish({ ok: false, detail: `could not connect to ${url}` });
    ws.onmessage = (m) => {
      if (typeof m.data !== "string") return;
      const msg = JSON.parse(m.data) as { type: string };
      finish({ ok: msg.type === "status", detail: `first message type "${msg.type}" (socket path /ws, REST prefix "${prefix || "(none)"}")` });
    };
  });
}

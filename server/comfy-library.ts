import type {ComfyLibrary, ComfyModelFolder, ComfyNodeInfo} from "../src/capabilities/types";
import {parseWorkerHardware} from "../src/capabilities/hardware";
import {MIN_FREE_RAM_SHARE} from "./memory-guard";

type WorkerRef = { id: string; name: string; origin: string; api_prefix: string };
type JsonFetcher = (url: string, init?: RequestInit) => Promise<Response>;

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_FOLDERS = 64;
const FOLDER_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 20000;
const folderName = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/;

class LibraryRequestError extends Error {
  constructor(readonly code: "request_failed" | "invalid_response") {
    super(code);
    this.name = "LibraryRequestError";
  }
}

/**
 * Reads object_info, system_stats and every model folder from one ComfyUI server.
 * Responses are bounded and normalized; raw bodies and addresses never leave this module.
 */
export async function loadComfyLibrary(worker: WorkerRef, fetcher: JsonFetcher = fetch): Promise<ComfyLibrary> {
  const base = `${worker.origin}${worker.api_prefix}`;
  const library: ComfyLibrary = {
    workerId: worker.id, workerName: worker.name, online: false, version: null,
    nodes: [], folders: [], issues: [], fetchedAt: new Date().toISOString(),
  };

  try {
    const [stats, info] = await Promise.all([
      json(`${base}/system_stats`, fetcher).catch(() => null),
      json(`${base}/object_info`, fetcher),
    ]);
    library.nodes = parseNodes(info);
    library.version = version(stats);
    if(stats)library.hardware=parseWorkerHardware(stats,MIN_FREE_RAM_SHARE);
    library.online = true;
  } catch (error) {
    library.issues.push(`object_info:${code(error)}`);
    return library;
  }

  let folders: string[];
  try {
    const listed = await json(`${base}/models`, fetcher);
    if (!Array.isArray(listed) || !listed.every(item => typeof item === "string")) throw new LibraryRequestError("invalid_response");
    folders = [...new Set(listed.filter((item): item is string => typeof item === "string" && folderName.test(item)))].sort().slice(0, MAX_FOLDERS);
  } catch (error) {
    library.issues.push(`models:${code(error)}`);
    return library;
  }

  const results = await mapLimit(folders, 4, async (name): Promise<ComfyModelFolder> => {
    try {
      const files = await json(`${base}/models/${encodeURIComponent(name)}`, fetcher);
      if (!Array.isArray(files) || !files.every(file => typeof file === "string")) throw new LibraryRequestError("invalid_response");
      return { name, files: [...new Set(files)].sort() };
    } catch (error) {
      library.issues.push(`models/${name}:${code(error)}`);
      return { name, files: [], error: code(error) };
    }
  });
  library.folders = results;
  return library;
}

async function json(url: string, fetcher: JsonFetcher): Promise<unknown> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(url.endsWith("/system_stats") || url.endsWith("/object_info") ? REQUEST_TIMEOUT_MS : FOLDER_TIMEOUT_MS), redirect: "error" });
  if (!response.ok) throw new LibraryRequestError("request_failed");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_JSON_BYTES)) throw new LibraryRequestError("invalid_response");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) throw new LibraryRequestError("invalid_response");
  try { return JSON.parse(text) as unknown; } catch { throw new LibraryRequestError("invalid_response"); }
}

function parseNodes(value: unknown): ComfyNodeInfo[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LibraryRequestError("invalid_response");
  const nodes: ComfyNodeInfo[] = [];
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const display = Array.isArray(entry.display_name) ? entry.display_name[0] : entry.display_name;
    const outputs = Array.isArray(entry.output) ? entry.output.filter((item): item is string => typeof item === "string") : [];
    nodes.push({
      name,
      displayName: typeof display === "string" && display.trim() ? display : name,
      category: typeof entry.category === "string" ? entry.category : "",
      outputs,
    });
  }
  nodes.sort((a, b) => a.category.localeCompare(b.category) || a.displayName.localeCompare(b.displayName));
  return nodes;
}

function version(stats: unknown): string | null {
  if (!stats || typeof stats !== "object") return null;
  const system = (stats as { system?: unknown }).system;
  if (!system || typeof system !== "object") return null;
  const value = (system as { comfyui_version?: unknown }).comfyui_version;
  return typeof value === "string" && value.length <= 80 ? value : null;
}

function code(error: unknown): "request_failed" | "invalid_response" {
  return error instanceof LibraryRequestError ? error.code : "request_failed";
}

async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

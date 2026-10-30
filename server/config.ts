import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export type ServerConfig = {
  databaseUrl: string;
  storageRoot: string;
  modelRoot?:string;
  masterKey: Buffer;
  publicOrigin: string;
  host: string;
  port: number;
  sessionTtlHours: number;
  inviteTtlHours: number;
  maxUploadBytes: number;
  cookieSecure: boolean;
  localSingleUser?: boolean;
  serveUi?: boolean;
  uiRoot?: string;
  /** Same hostname on a different port: host-only session cookies work, SOP isolates extensions. */
  nodeEditorOrigin?: string;
  nodeEditorPort?: number;
  /** A hosted text endpoint. Absent means text stays on the local ComfyUI worker. */
  aiText?: AiTextConfig;
  /** Comfy Cloud key from COMFY_CLOUD_API_KEY or COMFY_CLOUD_API_KEY_FILE. Never stored in the database. */
  comfyCloudApiKey?: string;
};

/** An endpoint that speaks the OpenAI chat-completions API: OpenRouter, OpenAI or DeepSeek. */
export type AiTextConfig = {
  url: string;
  model: string;
  apiKey?: string;
};

const MIN_MASTER_KEY_BYTES = 32;
const MAX_UPLOAD_MB = 2048;

function requireValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, name: string, max: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be between 1 and ${max}`);
  }
  return parsed;
}

export function parseMasterKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("MASTER_KEY must be base64 encoded");
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== MIN_MASTER_KEY_BYTES) {
    throw new Error("MASTER_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export function normalizePublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be an absolute HTTP(S) origin");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PUBLIC_ORIGIN must use http or https");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_ORIGIN must be an origin without credentials, path, query or fragment");
  }
  return url.origin;
}

function aiTextUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("COMFYFIELD_LLM_URL must be an absolute HTTP(S) address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("COMFYFIELD_LLM_URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("COMFYFIELD_LLM_URL must not carry credentials, a query or a fragment");
  }
  return value.replace(/\/+$/, "");
}

/**
 * Reads the optional hosted text endpoint. Every value is checked here and none
 * is ever echoed, so a bad setting fails at start instead of failing a request.
 */
export function aiTextConfig(env: NodeJS.ProcessEnv = process.env): AiTextConfig | undefined {
  const url = env.COMFYFIELD_LLM_URL?.trim();
  const model = env.COMFYFIELD_LLM_MODEL?.trim();
  const apiKey = env.COMFYFIELD_LLM_API_KEY?.trim();
  if (!url && !model && !apiKey) return undefined;
  if (!url) throw new Error("COMFYFIELD_LLM_URL is needed beside COMFYFIELD_LLM_MODEL and COMFYFIELD_LLM_API_KEY");
  if (!model) throw new Error("COMFYFIELD_LLM_MODEL is needed beside COMFYFIELD_LLM_URL");
  return {url: aiTextUrl(url), model, ...(apiKey ? {apiKey} : {})};
}

/** Key files already read, by full path and file stamp, so a start reads each file once. */
const cloudKeyFiles = new Map<string, { stamp: string; key: string }>();

/** One trimmed key line, with an optional NAME= prefix. A bad line never echoes the key. */
function cloudKeyLine(text: string, source: string): string | undefined {
  const line = text.trim();
  if (!line) return undefined;
  const key = line.replace(/^[A-Z][A-Z0-9_]*=/, "").trim();
  if (!key) return undefined;
  if (/\s/.test(key)) throw new Error(`${source} must be one key without spaces`);
  return key;
}

/** Reads the key file once per change. Missing or empty fails at start without naming the key. */
function comfyCloudKeyFromFile(file: string): string {
  const full = path.resolve(file);
  let stamp: string;
  try {
    const info = statSync(full);
    if (!info.isFile()) throw new Error("not a file");
    stamp = `${info.mtimeMs}:${info.size}`;
  } catch {
    throw new Error("COMFY_CLOUD_API_KEY_FILE is missing");
  }
  const cached = cloudKeyFiles.get(full);
  if (cached?.stamp === stamp) return cached.key;
  let text: string;
  try { text = readFileSync(full, "utf8"); } catch { throw new Error("COMFY_CLOUD_API_KEY_FILE is missing"); }
  const key = cloudKeyLine(text, "COMFY_CLOUD_API_KEY_FILE");
  if (!key) throw new Error("COMFY_CLOUD_API_KEY_FILE is empty");
  cloudKeyFiles.set(full, { stamp, key });
  return key;
}

/**
 * The only place a Comfy Cloud key is read. A worker row never holds it.
 * COMFY_CLOUD_API_KEY wins; otherwise COMFY_CLOUD_API_KEY_FILE names a file with one key line.
 */
export function comfyCloudKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env.COMFY_CLOUD_API_KEY?.trim();
  if (direct) {
    if (/\s/.test(direct)) throw new Error("COMFY_CLOUD_API_KEY must be one key without spaces");
    return direct;
  }
  const file = env.COMFY_CLOUD_API_KEY_FILE?.trim();
  return file ? comfyCloudKeyFromFile(file) : undefined;
}

/**
 * Replace character renders a long clip as chained 81-frame passes only when this is on.
 * It stays off until a real two-pass render has passed the seam check, so an unset or
 * differently spelled value keeps today's one 81-frame pass.
 */
export function scailChunksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMFYFIELD_SCAIL_CHUNKS?.trim() === "1";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = requireValue(env, "DATABASE_URL");
  const storageRoot = path.resolve(requireValue(env, "STORAGE_ROOT"));
  const masterKey = parseMasterKey(requireValue(env, "MASTER_KEY"));
  const publicOrigin = normalizePublicOrigin(requireValue(env, "PUBLIC_ORIGIN"));
  const maxUploadMb = positiveInteger(env.MAX_UPLOAD_MB, 128, "MAX_UPLOAD_MB", MAX_UPLOAD_MB);
  const port=positiveInteger(env.PORT,8787,"PORT",65535);
  const editorPort=positiveInteger(env.NODE_EDITOR_PORT,port===65535?65534:port+1,"NODE_EDITOR_PORT",65535);
  if(editorPort===port)throw new Error("NODE_EDITOR_PORT must differ from PORT");
  const publicUrl=new URL(publicOrigin),editorUrl=new URL(publicOrigin);
  editorUrl.port=String(editorPort);
  const nodeEditorOrigin=normalizePublicOrigin(env.NODE_EDITOR_ORIGIN?.trim()||editorUrl.origin);
  const configuredEditor=new URL(nodeEditorOrigin);
  if(nodeEditorOrigin===publicOrigin||configuredEditor.hostname!==publicUrl.hostname||configuredEditor.protocol!==publicUrl.protocol)
    throw new Error("NODE_EDITOR_ORIGIN must use the app hostname and protocol on a separate port");

  return {
    databaseUrl,
    storageRoot,
    modelRoot:env.COMFYFIELD_MODEL_ROOT?.trim()?path.resolve(env.COMFYFIELD_MODEL_ROOT.trim()):undefined,
    masterKey,
    publicOrigin,
    host: env.HOST?.trim() || "127.0.0.1",
    port,
    nodeEditorOrigin,
    nodeEditorPort:editorPort,
    aiText: aiTextConfig(env),
    comfyCloudApiKey: comfyCloudKey(env),
    sessionTtlHours: positiveInteger(env.SESSION_TTL_HOURS, 168, "SESSION_TTL_HOURS", 24 * 365),
    inviteTtlHours: positiveInteger(env.INVITE_TTL_HOURS, 72, "INVITE_TTL_HOURS", 24 * 30),
    maxUploadBytes: maxUploadMb * 1024 * 1024,
    cookieSecure: new URL(publicOrigin).protocol === "https:",
    localSingleUser: env.LOCAL_SINGLE_USER === "1",
    serveUi: env.SERVE_UI === "1",
    uiRoot: path.resolve(env.UI_ROOT ?? "dist"),
  };
}

export function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return requireValue(env, "DATABASE_URL");
}

import type {CapabilityManifestV2} from "../src/capabilities/types";
import type {ApiGraph} from "../src/workflow/build";
import { readFile } from "node:fs/promises";
import { Comfy } from "@comfyorg/sdk";
import { comfyCloudKey } from "./config";

/** The facts the transport needs about a worker: where it is and whether it is Comfy Cloud. */
export type SdkWorker = { origin: string; kind?: string | null };
/** Where a worker's v2 client points and the key it presents. */
export type SdkTarget = { base: string; apiKey?: string };

/** One client per base and key. The SDK captures both at construction, so they cannot be shared. */
const clients = new Map<string, Comfy>();
if (process.env.COMFY_SDK_BASE_URL?.trim()) console.log(`Comfy SDK transport enabled for ${process.env.COMFY_SDK_BASE_URL.trim()}`);

/**
 * A Cloud worker talks v2 at its own origin with the key from the environment; a local worker
 * keeps the single configured proxy base and needs no key. Undefined means "use the native path".
 */
export function sdkTarget(worker?: string | SdkWorker): SdkTarget | undefined {
  const origin = typeof worker === "string" ? worker : worker?.origin;
  if (typeof worker !== "string" && worker?.kind === "cloud") {
    if (!origin) return undefined;
    let base: string;
    try { base = new URL(origin).origin; } catch { return undefined; }
    // Without a key nothing can authenticate, so this worker keeps its native path.
    const apiKey = comfyCloudKey();
    return apiKey ? { base, apiKey } : undefined;
  }
  const base = process.env.COMFY_SDK_BASE_URL?.trim();
  if (!base) return undefined;
  if (!origin) return { base };
  // A single proxy points at exactly one worker. Never send another worker's
  // graph to it merely because that worker also supports image generation.
  try { return new URL(origin).origin === new URL(process.env.COMFY_SDK_WORKER_ORIGIN?.trim() || "http://127.0.0.1:8188").origin ? { base } : undefined; }
  catch { return undefined; }
}

/** The SDK is opt-in for a local worker; a Cloud worker gets it whenever its key is set. */
export function sdkTransportConfigured(worker?: string | SdkWorker): boolean {
  return sdkTarget(worker) !== undefined;
}

/**
 * One SDK client per base and key. The SDK reads COMFY_BASE_URL in its
 * constructor and captures it, so the environment is restored immediately and
 * concurrent requests cannot observe this temporary value.
 */
export function sdkClient(worker?: string | SdkWorker): Comfy {
  const target = sdkTarget(worker);
  if (!target) {
    if (typeof worker === "object" && worker.kind === "cloud") throw new Error("COMFY_CLOUD_API_KEY or COMFY_CLOUD_API_KEY_FILE is not configured");
    throw new Error("COMFY_SDK_BASE_URL is not configured");
  }
  const cacheKey = `${target.base}\u0000${target.apiKey ?? ""}`;
  const cached = clients.get(cacheKey);
  if (cached) return cached;
  const previous = process.env.COMFY_BASE_URL;
  process.env.COMFY_BASE_URL = target.base;
  try {
    const client = new Comfy({ clientInfo: "ComfyField", ...(target.apiKey ? { apiKey: target.apiKey } : {}) });
    clients.set(cacheKey, client);
    return client;
  } finally {
    if (previous === undefined) delete process.env.COMFY_BASE_URL;
    else process.env.COMFY_BASE_URL = previous;
  }
}

/** Contracts with extra source/normalization/artifact invariants retain their qualified native path.
 *  A replace contract is graph-level (the chunk compile rewrites the graph after compileLocal), so the
 *  SDK path would post one 81-frame pass with no error. */
export function sdkSupportsManifest(manifest:CapabilityManifestV2):boolean{
  return manifest.outputs.some(output=>output.required&&(output.type==="image"||output.type==="video"))&&!manifest.voiceContract&&!manifest.motionContract&&!manifest.mediaContract&&!manifest.imageInputContract&&!manifest.imageArtifacts&&!manifest.outputContract&&!manifest.posePreviewContract&&!manifest.replaceContract;
}

/** One input on its way to Comfy Cloud: the role the manifest names, the name the graph loads,
 *  the media type, and the file this server keeps the bytes in. */
export type CloudInputFile = { role: string; filename: string; contentType: string; path: string };

/** One line for a run's error field: what the SDK call said, in its own plain words, with the HTTP
 *  status when it carried one. The key never appears here — it only ever travels in a header. */
export function sdkFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { httpStatus?: unknown } | undefined)?.httpStatus;
  const text = message.replace(/\s+/g, " ").trim().slice(0, 240) || "Comfy Cloud did not say why";
  return typeof status === "number" ? `${text} (HTTP ${status})` : text;
}

/**
 * Comfy Cloud has no ComfyUI input folder — `/api/upload/image` answers 404 there — so an input
 * becomes a Cloud asset instead, and the loader's file field carries that asset's `core/ASSET`
 * reference, which is what the graph then loads. The graph is compiled first, with the same names,
 * because compileLocal only accepts files the server has named. Returns the asset id per role, so
 * the run event can record what was uploaded.
 */
export async function cloudInputs(client: Comfy, manifest: CapabilityManifestV2, graph: ApiGraph, files: CloudInputFile[]): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const file of files) {
    const binding = manifest.inputs.find(input => input.id === file.role)?.binding;
    const node = binding ? graph[binding.node] : undefined;
    if (!binding || !node || !(binding.field in node.inputs)) throw new Error(`Missing input binding: ${file.role}`);
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await readFile(file.path)); }
    catch (error) { throw new Error(`Could not read ${file.role}: ${(error as Error).message}`); }
    const asset = client.assets.fromBytes(bytes, { filename: file.filename, contentType: file.contentType });
    try {
      ids[file.role] = await asset.commit();
    } catch (error) {
      throw new Error(`Comfy Cloud did not take ${file.role} as an asset: ${sdkFailureReason(error)}`);
    }
    // The SDK swaps this handle for its core/ASSET reference when the graph is submitted.
    node.inputs[binding.field] = asset;
  }
  return ids;
}

// Turns what ComfyUI reports (history entries and queue items) into the studio's Job type.
// Pure functions: the hook feeds them responses, tests feed them captured ones.

import { firstOutputFile, type HistoryEntry, type RawQueue, type RawQueueItem } from "../comfy/client";
import { matchProvider, readParams, type RecoveredParams } from "../pipelines/recover";
import type { Enhancer, Provider } from "../pipelines/registry";
import { matchEnhancer, readEnhanceParams } from "../workflow/enhance";
import type { Job } from "./types";

/** How many sampler passes a graph runs: one per sampler node. */
export function countSamplers(graph: Record<string, { class_type: string }>): number {
  return Math.max(1, Object.values(graph).filter((n) => n.class_type.startsWith("KSampler")).length);
}

type Base = Omit<Job, "status" | "progress" | "queuePosition">;

/**
 * What the studio attaches to an enhance job as `extra_data.studio`. An enhance graph holds only the
 * clip and the factor, so the prompt and settings of the clip it came from travel here.
 */
export type EnhanceMeta = { kind: "enhance"; sourceJobId?: string; sourceParams?: RecoveredParams };

const EMPTY_PARAMS: RecoveredParams = { prompt: "", negative: "", startImage: "", aspect: "landscape", durationSec: 0, seed: 0 };

function readEnhanceMeta(extra: RawQueueItem[3]): EnhanceMeta | undefined {
  const s = extra?.studio as Partial<EnhanceMeta> | undefined;
  return s && s.kind === "enhance" ? (s as EnhanceMeta) : undefined;
}

function generationBase(promptId: string, item: RawQueueItem, provider: Provider): Base {
  const params = readParams(item[2], provider.manifest);
  return {
    id: promptId,
    promptId,
    providerId: provider.id,
    model: provider.manifest.display.short,
    resolution: provider.manifest.display.resolution,
    params,
    stages: countSamplers(item[2]),
    thumb: params.startImage ? { kind: "input", filename: params.startImage } : null,
    endThumb: params.endImage ? { kind: "input", filename: params.endImage } : null,
    motionThumb: params.motionVideo ? { kind: "input", filename: params.motionVideo } : null,
    createdAt: item[3]?.create_time ?? Date.now(),
  };
}

function enhanceBase(promptId: string, item: RawQueueItem, enhancer: Enhancer): Base {
  const { sourceVideo, factor } = readEnhanceParams(item[2], enhancer.manifest);
  const meta = readEnhanceMeta(item[3]);
  return {
    id: promptId,
    promptId,
    kind: "enhance",
    providerId: enhancer.id,
    model: `${enhancer.manifest.display.short} ${factor}×`,
    resolution: `${factor}× larger`,
    params: meta?.sourceParams ?? EMPTY_PARAMS,
    stages: 1,
    thumb: null,
    endThumb: null,
    enhance: { factor, sourceVideo, sourceJobId: meta?.sourceJobId },
    createdAt: item[3]?.create_time ?? Date.now(),
  };
}

/** The job's base fields and its output node, or undefined for a graph the studio did not make. */
function describe(promptId: string, item: RawQueueItem, providers: Provider[], enhancers: Enhancer[]): { base: Base; outputNode: string } | undefined {
  const provider = matchProvider(item[2], providers);
  if (provider) return { base: generationBase(promptId, item, provider), outputNode: provider.manifest.outputs.video.node ?? "" };
  const enhancer = matchEnhancer(item[2], enhancers);
  if (enhancer) return { base: enhanceBase(promptId, item, enhancer), outputNode: enhancer.manifest.outputs.video.node ?? "" };
  return undefined;
}

function messageTime(entry: HistoryEntry, name: string): number | undefined {
  const hit = entry.status?.messages?.find((m) => m[0] === name);
  const t = hit?.[1]?.timestamp;
  return typeof t === "number" ? t : undefined;
}

/** A finished job, or undefined when the graph was not made by one of our providers or enhancers. */
export function jobFromHistory(promptId: string, entry: HistoryEntry, providers: Provider[], enhancers: Enhancer[] = []): Job | undefined {
  if (!entry.prompt) return undefined;
  const found = describe(promptId, entry.prompt, providers, enhancers);
  if (!found) return undefined;
  const { base, outputNode } = found;

  const start = messageTime(entry, "execution_start");
  const end = messageTime(entry, "execution_success") ?? messageTime(entry, "execution_error") ?? messageTime(entry, "execution_interrupted");
  const runMs = start !== undefined && end !== undefined ? end - start : undefined;

  const messages = entry.status?.messages ?? [];
  const interrupted = messages.some((m) => m[0] === "execution_interrupted");
  const failure = messages.find((m) => m[0] === "execution_error")?.[1] as { exception_message?: string } | undefined;

  if (entry.status?.status_str === "error") {
    if (interrupted) return { ...base, status: "cancelled", progress: null, queuePosition: null, runMs };
    return {
      ...base,
      status: "failed",
      progress: null,
      queuePosition: null,
      runMs,
      errorTitle: "ComfyUI stopped the job",
      errorLines: [firstLine(failure?.exception_message) ?? "Check the ComfyUI console for details."],
    };
  }

  const output = firstOutputFile(entry.outputs[outputNode]);
  if (!output) {
    return {
      ...base,
      status: "failed",
      progress: null,
      queuePosition: null,
      runMs,
      errorTitle: "The job finished without a video",
      errorLines: ["ComfyUI reported success but the output node saved no file."],
    };
  }
  return { ...base, status: "done", progress: 100, queuePosition: null, output, runMs };
}

/** Running and pending jobs. A pending job's position is its place in the pending list: 1 runs next. */
export function jobsFromQueue(queue: RawQueue, providers: Provider[], enhancers: Enhancer[] = []): Job[] {
  const jobs: Job[] = [];
  for (const item of queue.queue_running) {
    const found = describe(item[1], item, providers, enhancers);
    if (found) jobs.push({ ...found.base, status: "running", progress: null, queuePosition: null });
  }
  queue.queue_pending.forEach((item, index) => {
    const found = describe(item[1], item, providers, enhancers);
    if (found) jobs.push({ ...found.base, status: "queued", progress: null, queuePosition: index + 1 });
  });
  return jobs;
}

/** All of the studio's jobs in a history response. Entries from other frontends are skipped. */
export function jobsFromHistory(history: Record<string, HistoryEntry>, providers: Provider[], enhancers: Enhancer[] = []): Job[] {
  return Object.entries(history)
    .map(([id, entry]) => jobFromHistory(id, entry, providers, enhancers))
    .filter((j): j is Job => j !== undefined);
}

function firstLine(text: string | undefined): string | undefined {
  return text?.split("\n").find((l) => l.trim())?.trim();
}

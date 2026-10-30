import type { OutputFile } from "../comfy/client";
import type { Job } from "../jobs/types";
import type { RecoveredParams } from "../pipelines/recover";
import type { Enhancer, Provider } from "../pipelines/registry";
import type { ApiGraph } from "../workflow/build";
import type { EnhanceManifest, ExecutionDeclaration, Manifest } from "../workflow/manifest";

export const RUN_LEDGER_VERSION = 1 as const;

export type RunCaptureSource = "studio-submission" | "history-recovery";

export type AcceptedRunInput = {
  providerId: string;
  pipeline: string;
  kind: "generate" | "enhance";
  model: string;
  resolution: string;
  execution: ExecutionDeclaration;
  effectiveParams: RecoveredParams;
  createdAt: number;
  graph: ApiGraph;
  manifest: Manifest | EnhanceManifest;
  enhance?: { factor: number; sourceVideo: string; sourceJobId?: string };
};

export type RunRecord = {
  promptId: string;
  capturedAt: number;
  captureSource: RunCaptureSource;
  providerId: string;
  pipeline: string;
  kind: "generate" | "enhance";
  model: string;
  resolution: string;
  execution: ExecutionDeclaration;
  effectiveParams: RecoveredParams;
  createdAt: number;
  enhance?: { factor: number; sourceVideo: string; sourceJobId?: string };
  fingerprints?: { graphSha256?: string; manifestSha256?: string };
  observation: {
    status: Job["status"];
    observedAt: number;
    output?: OutputFile;
    runMs?: number;
  };
};

export type RunLedger = {
  version: typeof RUN_LEDGER_VERSION;
  records: Record<string, RunRecord>;
};

export const emptyRunLedger = (): RunLedger => ({ version: RUN_LEDGER_VERSION, records: {} });

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isStatus = (value: unknown): value is Job["status"] => ["uploading", "queued", "running", "done", "failed", "cancelled"].includes(String(value));
const isCaptureSource = (value: unknown): value is RunCaptureSource => value === "studio-submission" || value === "history-recovery";

function executionFrom(value: unknown): ExecutionDeclaration | null {
  if (!isObject(value)) return null;
  if (value.route === "native-comfy") return { route: "native-comfy" };
  if (value.route === "api-via-comfy" && typeof value.service === "string" && value.service.trim()) {
    return { route: "api-via-comfy", service: value.service };
  }
  if (value.route === "unknown") return { route: "unknown" };
  return null;
}

function paramsFrom(value: unknown): RecoveredParams | null {
  if (!isObject(value)) return null;
  if (
    typeof value.prompt !== "string" ||
    typeof value.negative !== "string" ||
    typeof value.startImage !== "string" ||
    typeof value.aspect !== "string" ||
    typeof value.durationSec !== "number" ||
    !Number.isFinite(value.durationSec) ||
    typeof value.seed !== "number" ||
    !Number.isFinite(value.seed)
  ) return null;
  return {
    prompt: value.prompt,
    negative: value.negative,
    startImage: value.startImage,
    endImage: typeof value.endImage === "string" ? value.endImage : "",
    motionVideo: typeof value.motionVideo === "string" ? value.motionVideo : "",
    motionPrompt: typeof value.motionPrompt === "string" ? value.motionPrompt : "",
    aspect: value.aspect,
    durationSec: value.durationSec,
    seed: value.seed,
  };
}

function outputFrom(value: unknown): OutputFile | undefined {
  if (!isObject(value) || typeof value.filename !== "string" || typeof value.subfolder !== "string" || typeof value.type !== "string") return undefined;
  return { filename: value.filename, subfolder: value.subfolder, type: value.type };
}

function enhanceFrom(value: unknown): RunRecord["enhance"] {
  if (!isObject(value) || typeof value.factor !== "number" || !Number.isFinite(value.factor) || typeof value.sourceVideo !== "string") return undefined;
  return { factor: value.factor, sourceVideo: value.sourceVideo, sourceJobId: typeof value.sourceJobId === "string" ? value.sourceJobId : undefined };
}

function recordFrom(key: string, value: unknown): RunRecord | null {
  if (!isObject(value)) return null;
  const execution = executionFrom(value.execution);
  const effectiveParams = paramsFrom(value.effectiveParams);
  const observation = isObject(value.observation) ? value.observation : null;
  if (
    typeof value.promptId !== "string" || value.promptId !== key ||
    typeof value.capturedAt !== "number" || !Number.isFinite(value.capturedAt) ||
    !isCaptureSource(value.captureSource) ||
    typeof value.providerId !== "string" || typeof value.pipeline !== "string" ||
    (value.kind !== "generate" && value.kind !== "enhance") ||
    typeof value.model !== "string" || typeof value.resolution !== "string" ||
    !execution || !effectiveParams ||
    typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) ||
    !observation || !isStatus(observation.status) ||
    typeof observation.observedAt !== "number" || !Number.isFinite(observation.observedAt)
  ) return null;

  const fingerprints = isObject(value.fingerprints)
    ? {
        graphSha256: typeof value.fingerprints.graphSha256 === "string" ? value.fingerprints.graphSha256 : undefined,
        manifestSha256: typeof value.fingerprints.manifestSha256 === "string" ? value.fingerprints.manifestSha256 : undefined,
      }
    : undefined;
  return {
    promptId: value.promptId,
    capturedAt: value.capturedAt,
    captureSource: value.captureSource,
    providerId: value.providerId,
    pipeline: value.pipeline,
    kind: value.kind,
    model: value.model,
    resolution: value.resolution,
    execution,
    effectiveParams,
    createdAt: value.createdAt,
    enhance: enhanceFrom(value.enhance),
    fingerprints: fingerprints?.graphSha256 || fingerprints?.manifestSha256 ? fingerprints : undefined,
    observation: {
      status: observation.status,
      observedAt: observation.observedAt,
      output: outputFrom(observation.output),
      runMs: typeof observation.runMs === "number" && Number.isFinite(observation.runMs) ? observation.runMs : undefined,
    },
  };
}

export function parseRunLedger(raw: string | null): RunLedger {
  if (!raw) return emptyRunLedger();
  const value: unknown = JSON.parse(raw);
  if (!isObject(value) || value.version !== RUN_LEDGER_VERSION || !isObject(value.records)) {
    throw new Error("Run ledger has an unsupported or invalid shape");
  }
  const records: Record<string, RunRecord> = {};
  for (const [key, candidate] of Object.entries(value.records)) {
    const record = recordFrom(key, candidate);
    if (!record) throw new Error(`Run ledger record ${key} is invalid`);
    records[key] = record;
  }
  return { version: RUN_LEDGER_VERSION, records };
}

export function acceptRun(ledger: RunLedger, promptId: string, input: AcceptedRunInput, at = Date.now()): RunLedger {
  const prior = ledger.records[promptId];
  const record: RunRecord = {
    promptId,
    capturedAt: at,
    captureSource: "studio-submission",
    providerId: input.providerId,
    pipeline: input.pipeline,
    kind: input.kind,
    model: input.model,
    resolution: input.resolution,
    execution: input.execution,
    effectiveParams: structuredClone(input.effectiveParams),
    createdAt: input.createdAt,
    enhance: input.enhance ? { ...input.enhance } : undefined,
    fingerprints: prior?.fingerprints,
    observation: prior?.observation ?? { status: "queued", observedAt: at },
  };
  return { version: RUN_LEDGER_VERSION, records: { ...ledger.records, [promptId]: record } };
}

export function addFingerprints(ledger: RunLedger, promptId: string, graphSha256: string, manifestSha256: string): RunLedger {
  const prior = ledger.records[promptId];
  if (!prior) return ledger;
  return {
    version: RUN_LEDGER_VERSION,
    records: { ...ledger.records, [promptId]: { ...prior, fingerprints: { graphSha256, manifestSha256 } } },
  };
}

function descriptor(job: Job, providers: Provider[], enhancers: Enhancer[]) {
  const provider = providers.find((candidate) => candidate.id === job.providerId);
  if (provider) return { pipeline: provider.pipeline, execution: provider.manifest.execution ?? { route: "unknown" as const } };
  const enhancer = enhancers.find((candidate) => candidate.id === job.providerId);
  if (enhancer) return { pipeline: enhancer.pipeline, execution: enhancer.manifest.execution ?? { route: "unknown" as const } };
  return { pipeline: job.kind === "enhance" ? "enhance" : "unknown", execution: { route: "unknown" as const } };
}

export function observeJobs(ledger: RunLedger, jobs: Job[], providers: Provider[], enhancers: Enhancer[], at = Date.now()): RunLedger {
  let records = ledger.records;
  let changed = false;
  for (const job of jobs) {
    if (!job.promptId) continue;
    const prior = records[job.promptId];
    const nextObservation: RunRecord["observation"] = {
      status: job.status,
      observedAt: at,
      output: job.output ? { ...job.output } : undefined,
      runMs: job.runMs,
    };
    if (prior) {
      const same =
        prior.observation.status === nextObservation.status &&
        prior.observation.runMs === nextObservation.runMs &&
        JSON.stringify(prior.observation.output) === JSON.stringify(nextObservation.output);
      if (same) continue;
      records = { ...records, [job.promptId]: { ...prior, observation: nextObservation } };
      changed = true;
      continue;
    }
    const found = descriptor(job, providers, enhancers);
    records = {
      ...records,
      [job.promptId]: {
        promptId: job.promptId,
        capturedAt: at,
        captureSource: "history-recovery",
        providerId: job.providerId,
        pipeline: found.pipeline,
        kind: job.kind === "enhance" ? "enhance" : "generate",
        model: job.model,
        resolution: job.resolution,
        execution: found.execution,
        effectiveParams: structuredClone(job.params),
        createdAt: job.createdAt,
        enhance: job.enhance ? { ...job.enhance } : undefined,
        observation: nextObservation,
      },
    };
    changed = true;
  }
  return changed ? { version: RUN_LEDGER_VERSION, records } : ledger;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function exportRunRecord(record: RunRecord): string {
  return JSON.stringify({ schema: "bashpacks.video-studio.run-record.v1", record }, null, 2);
}

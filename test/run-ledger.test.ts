import { describe, expect, it } from "vitest";
import type { Job } from "../src/jobs/types";
import { providers } from "../src/pipelines/registry";
import { readParams } from "../src/pipelines/recover";
import {
  acceptRun,
  addFingerprints,
  emptyRunLedger,
  exportRunRecord,
  observeJobs,
  parseRunLedger,
  sha256Json,
  type AcceptedRunInput,
} from "../src/runs/records";
import { loadRunLedger, updateRunLedger, type RunLedgerStorage } from "../src/runs/store";
import { runLedgerStorageKey } from "../src/runs/useRunLedger";
import { buildGraph } from "../src/workflow/build";

const provider = providers.find((candidate) => candidate.id === "wan22-ti2v-5b")!;
const graph = buildGraph(provider.template, provider.manifest, {
  prompt: "waves",
  negative: "",
  startImage: "studio-input.png",
  resolution: "portrait",
  durationSec: 3,
  seed: 17,
});

const accepted: AcceptedRunInput = {
  providerId: provider.id,
  pipeline: provider.pipeline,
  kind: "generate",
  model: provider.manifest.display.short,
  resolution: provider.manifest.display.resolution,
  execution: provider.manifest.execution ?? { route: "unknown" },
  effectiveParams: readParams(graph, provider.manifest),
  createdAt: 100,
  graph,
  manifest: provider.manifest,
};

const job = (over: Partial<Job> = {}): Job => ({
  id: "server-1",
  promptId: "server-1",
  status: "done",
  progress: 100,
  queuePosition: null,
  providerId: provider.id,
  model: provider.manifest.display.short,
  resolution: provider.manifest.display.resolution,
  params: accepted.effectiveParams,
  thumb: { kind: "input", filename: "studio-input.png" },
  output: { filename: "video.mp4", subfolder: "output", type: "output" },
  createdAt: 100,
  runMs: 2500,
  ...over,
});

describe("run ledger", () => {
  it("records accepted submission facts and effective template defaults", () => {
    const ledger = acceptRun(emptyRunLedger(), "server-1", accepted, 200);
    const record = ledger.records["server-1"];
    expect(record).toMatchObject({
      captureSource: "studio-submission",
      execution: { route: "native-comfy" },
      providerId: provider.id,
      pipeline: "i2v",
      observation: { status: "queued" },
    });
    expect(record.effectiveParams.negative.length).toBeGreaterThan(10);
    expect(record.effectiveParams).toMatchObject({ prompt: "waves", startImage: "studio-input.png", aspect: "portrait", seed: 17 });
  });

  it("updates observations without overwriting immutable accepted facts", () => {
    let ledger = acceptRun(emptyRunLedger(), "server-1", accepted, 200);
    ledger = observeJobs(ledger, [job({ model: "changed display", params: { ...accepted.effectiveParams, seed: 999 } })], providers, [], 300);
    expect(ledger.records["server-1"]).toMatchObject({
      captureSource: "studio-submission",
      model: accepted.model,
      effectiveParams: { seed: 17 },
      observation: { status: "done", runMs: 2500, output: { filename: "video.mp4" } },
    });
  });

  it("labels a history-only job as inferred and does not need a current-session submission", () => {
    const ledger = observeJobs(emptyRunLedger(), [job()], providers, [], 300);
    expect(ledger.records["server-1"]).toMatchObject({
      captureSource: "history-recovery",
      execution: { route: "native-comfy" },
      observation: { status: "done" },
    });
  });

  it("upgrades a recovered record when the same prompt ID is later recorded at acceptance", () => {
    let ledger = observeJobs(emptyRunLedger(), [job()], providers, [], 300);
    ledger = acceptRun(ledger, "server-1", accepted, 400);
    expect(ledger.records["server-1"]).toMatchObject({ captureSource: "studio-submission", observation: { status: "done" } });
  });

  it("adds deterministic SHA-256 fingerprints without persisting raw graphs", async () => {
    expect(await sha256Json({ b: 2, a: 1 })).toBe(await sha256Json({ a: 1, b: 2 }));
    let ledger = acceptRun(emptyRunLedger(), "server-1", accepted, 200);
    ledger = addFingerprints(ledger, "server-1", await sha256Json(graph), await sha256Json(provider.manifest));
    const exported = exportRunRecord(ledger.records["server-1"]);
    expect(ledger.records["server-1"].fingerprints?.graphSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(exported).toContain("bashpacks.video-studio.run-record.v1");
    expect(exported).not.toContain("class_type");
  });

  it.each(["not json", JSON.stringify({ version: 2, records: {} }), JSON.stringify({ version: 1, records: [] })])(
    "rejects corrupt or unsupported storage: %s",
    (raw) => expect(() => parseRunLedger(raw)).toThrow(),
  );

  it("rejects an invalid record so later writes cannot silently discard corrupt stored data", () => {
    const valid = acceptRun(emptyRunLedger(), "server-1", accepted, 200);
    expect(() => parseRunLedger(JSON.stringify({ version: 1, records: { ...valid.records, broken: { promptId: "other" } } }))).toThrow(/broken/);
  });

  it("does not report a quota-failed write as persisted", () => {
    let raw: string | null = null;
    const storage: RunLedgerStorage = {
      getItem: () => raw,
      setItem: () => { throw new Error("quota"); },
    };
    expect(() => updateRunLedger(storage, "runs", (current) => acceptRun(current, "server-1", accepted, 200))).toThrow("quota");
    expect(raw).toBeNull();
    expect(loadRunLedger(storage, "runs").records).toEqual({});
  });

  it("scopes records to the configured Comfy base string", () => {
    expect(runLedgerStorageKey("/comfy")).not.toBe(runLedgerStorageKey("http://other:8188"));
  });
});

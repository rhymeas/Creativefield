import { describe, expect, it } from "vitest";
import { providers } from "../src/pipelines/registry";
import { matchProvider, readParams } from "../src/pipelines/recover";
import { buildGraph, type ApiGraph } from "../src/workflow/build";
import { jobFromHistory, jobsFromHistory, jobsFromQueue } from "../src/jobs/server";
import { jobsReducer } from "../src/jobs/machine";
import type { Job } from "../src/jobs/types";
import type { HistoryEntry, RawQueueItem } from "../src/comfy/client";
import fixtureTemplate from "./fixtures/fixture_i2v_api.json";

const wan = providers.find((p) => p.id === "wan22-ti2v-5b")!;

const graphFor = (over: Partial<{ prompt: string; aspect: string; durationSec: number; seed: number }> = {}): ApiGraph =>
  buildGraph(wan.template, wan.manifest, {
    prompt: over.prompt ?? "a lake at dusk",
    negative: "",
    startImage: "studio-abc-lake.png",
    resolution: over.aspect ?? "landscape",
    durationSec: over.durationSec ?? 3,
    seed: over.seed ?? 99,
  });

const queueItem = (id: string, graph: ApiGraph, createTime = 1000, priority = 1): RawQueueItem => [priority, id, graph, { create_time: createTime }, ["58"]];

const historyEntry = (graph: ApiGraph, over: Partial<HistoryEntry> = {}, id = "job-1"): HistoryEntry => ({
  prompt: queueItem(id, graph, 5000),
  outputs: { "58": { images: [{ filename: "ComfyUI_00001_.mp4", subfolder: "video", type: "output" }], animated: [true] } },
  status: {
    status_str: "success",
    completed: true,
    messages: [
      ["execution_start", { timestamp: 10_000 }],
      ["execution_success", { timestamp: 82_500 }],
    ],
  },
  ...over,
});

describe("matchProvider and readParams", () => {
  it("matches a graph built from a provider's template", () => {
    expect(matchProvider(graphFor(), providers)?.id).toBe("wan22-ti2v-5b");
  });

  it("does not match another frontend's graph", () => {
    expect(matchProvider(fixtureTemplate as ApiGraph, providers)).toBeUndefined();
    expect(matchProvider({ "1": { class_type: "KSampler", inputs: {} } }, providers)).toBeUndefined();
  });

  it("reads the studio's parameters back out of a graph", () => {
    const p = readParams(graphFor({ prompt: "waves", aspect: "portrait", durationSec: 3, seed: 7 }), wan.manifest);
    expect(p).toMatchObject({ prompt: "waves", aspect: "portrait", durationSec: 3, seed: 7, startImage: "studio-abc-lake.png" });
  });

  it("reads back the template's default negative prompt when none was given", () => {
    expect(readParams(graphFor(), wan.manifest).negative.length).toBeGreaterThan(10);
  });
});

describe("jobs from ComfyUI history", () => {
  it("rebuilds a finished job with its video, time, and parameters", () => {
    const job = jobFromHistory("job-1", historyEntry(graphFor({ durationSec: 5 })), providers)!;
    expect(job).toMatchObject({
      id: "job-1",
      promptId: "job-1",
      status: "done",
      progress: 100,
      model: "Wan 2.2 TI2V 5B",
      resolution: "720p",
      createdAt: 5000,
      runMs: 72_500,
      output: { filename: "ComfyUI_00001_.mp4", subfolder: "video", type: "output" },
      thumb: { kind: "input", filename: "studio-abc-lake.png" },
    });
    expect(job.params.durationSec).toBe(5);
  });

  it("reports a failed job with the first line of ComfyUI's message", () => {
    const job = jobFromHistory(
      "j",
      historyEntry(graphFor(), {
        outputs: {},
        status: {
          status_str: "error",
          messages: [["execution_error", { exception_message: "CUDA out of memory\nTried to allocate 2 GiB" }]],
        },
      }),
      providers,
    )!;
    expect(job).toMatchObject({ status: "failed", errorTitle: "ComfyUI stopped the job", errorLines: ["CUDA out of memory"] });
  });

  it("reports an interrupted job as cancelled, not failed", () => {
    const job = jobFromHistory(
      "j",
      historyEntry(graphFor(), { outputs: {}, status: { status_str: "error", messages: [["execution_interrupted", {}]] } }),
      providers,
    )!;
    expect(job.status).toBe("cancelled");
  });

  it("does not call a job done when no video was saved", () => {
    const job = jobFromHistory("j", historyEntry(graphFor(), { outputs: {} }), providers)!;
    expect(job).toMatchObject({ status: "failed", errorTitle: "The job finished without a video" });
  });

  it("skips jobs from other frontends", () => {
    const history = {
      mine: historyEntry(graphFor(), {}, "mine"),
      theirs: historyEntry({ "1": { class_type: "SaveImage", inputs: {} } }, {}, "theirs"),
    };
    expect(jobsFromHistory(history, providers).map((j) => j.id)).toEqual(["mine"]);
  });
});

describe("jobs from the queue", () => {
  it("marks the running job and numbers the pending ones", () => {
    const jobs = jobsFromQueue(
      {
        queue_running: [queueItem("run", graphFor())],
        queue_pending: [queueItem("p1", graphFor()), queueItem("p2", graphFor())],
      },
      providers,
    );
    expect(jobs.map((j) => [j.id, j.status, j.queuePosition])).toEqual([
      ["run", "running", null],
      ["p1", "queued", 1],
      ["p2", "queued", 2],
    ]);
  });

  it("counts another frontend's pending job as ahead of ours", () => {
    const foreign = queueItem("x", { "1": { class_type: "SaveImage", inputs: {} } });
    const jobs = jobsFromQueue({ queue_running: [], queue_pending: [foreign, queueItem("mine", graphFor())] }, providers);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].queuePosition).toBe(2);
  });
});

describe("jobsReducer", () => {
  const job = (over: Partial<Job> = {}): Job => ({
    id: "local-1",
    status: "uploading",
    progress: null,
    queuePosition: null,
    providerId: "wan22-ti2v-5b",
    model: "Wan 2.2 TI2V 5B",
    resolution: "720p",
    params: { prompt: "p", negative: "", startImage: "a.png", aspect: "landscape", durationSec: 3, seed: 1 },
    thumb: { kind: "blob", url: "blob:local" },
    createdAt: 100,
    ...over,
  });

  it("orders jobs newest first", () => {
    let jobs = jobsReducer([], { type: "add", job: job({ id: "old", createdAt: 1 }) });
    jobs = jobsReducer(jobs, { type: "add", job: job({ id: "new", createdAt: 2 }) });
    expect(jobs.map((j) => j.id)).toEqual(["new", "old"]);
  });

  it("moves an uploading job to queued when ComfyUI accepts it", () => {
    const jobs = jobsReducer([job()], { type: "accepted", id: "local-1", promptId: "srv-1" });
    expect(jobs[0]).toMatchObject({ status: "queued", promptId: "srv-1" });
  });

  it("turns progress events into a running job with a percentage", () => {
    const start = [job({ status: "queued", promptId: "srv-1", queuePosition: 1 })];
    const jobs = jobsReducer(start, { type: "event", event: { type: "progress", value: 5, max: 20, node: "3", promptId: "srv-1" } });
    expect(jobs[0]).toMatchObject({ status: "running", progress: 25, queuePosition: null });
  });

  it("ignores events for finished jobs and events with no prompt id", () => {
    const done = [job({ status: "done", promptId: "srv-1" })];
    expect(jobsReducer(done, { type: "event", event: { type: "interrupted", promptId: "srv-1" } })[0].status).toBe("done");
    const active = [job({ status: "running", promptId: "srv-1" })];
    expect(jobsReducer(active, { type: "event", event: { type: "interrupted" } })).toBe(active);
  });

  it("marks jobs cancelled or failed from live events", () => {
    const running = [job({ status: "running", promptId: "srv-1" })];
    expect(jobsReducer(running, { type: "event", event: { type: "interrupted", promptId: "srv-1" } })[0].status).toBe("cancelled");
    const failed = jobsReducer(running, { type: "event", event: { type: "execution_error", promptId: "srv-1", message: "boom" } })[0];
    expect(failed).toMatchObject({ status: "failed", errorLines: ["boom"] });
  });

  describe("synced", () => {
    const server = (over: Partial<Job> = {}): Job => job({ id: "srv-1", promptId: "srv-1", thumb: { kind: "input", filename: "a.png" }, ...over });

    it("adds jobs it has not seen, as after a page reload", () => {
      const jobs = jobsReducer([], { type: "synced", jobs: [server({ status: "done", progress: 100 })] });
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe("done");
    });

    it("keeps a local upload that the server does not know yet", () => {
      const jobs = jobsReducer([job()], { type: "synced", jobs: [] });
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe("uploading");
    });

    it("keeps the local blob thumbnail and live progress when the server confirms a running job", () => {
      const local = job({ id: "local-1", promptId: "srv-1", status: "running", progress: 40 });
      const jobs = jobsReducer([local], { type: "synced", jobs: [server({ status: "running" })] });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ id: "local-1", progress: 40, thumb: { kind: "blob" } });
    });

    it("never moves a job backwards when the snapshot is older", () => {
      const local = job({ promptId: "srv-1", status: "running", progress: 10 });
      const jobs = jobsReducer([local], { type: "synced", jobs: [server({ status: "queued", queuePosition: 1 })] });
      expect(jobs[0].status).toBe("running");
    });

    it("lets a finished server state override a running local one", () => {
      const local = job({ promptId: "srv-1", status: "running", progress: 90 });
      const output = { filename: "v.mp4", subfolder: "video", type: "output" };
      const jobs = jobsReducer([local], { type: "synced", jobs: [server({ status: "done", progress: 100, output })] });
      expect(jobs[0]).toMatchObject({ status: "done", progress: 100, output });
    });

    it("updates the queue position of a queued job", () => {
      const local = job({ promptId: "srv-1", status: "queued", queuePosition: 3 });
      const jobs = jobsReducer([local], { type: "synced", jobs: [server({ status: "queued", queuePosition: 1 })] });
      expect(jobs[0].queuePosition).toBe(1);
    });
  });
});

describe("progress across several samplers", () => {
  const running = (over: Partial<Job> = {}): Job => ({
    id: "l",
    promptId: "p",
    status: "running",
    progress: null,
    queuePosition: null,
    providerId: "x",
    model: "m",
    resolution: "r",
    params: { prompt: "", negative: "", startImage: "", aspect: "landscape", durationSec: 1, seed: 1 },
    thumb: null,
    createdAt: 1,
    ...over,
  });
  const tick = (jobs: Job[], node: string, value: number, max: number) =>
    jobsReducer(jobs, { type: "event", event: { type: "progress", value, max, node, promptId: "p" } });

  it("folds two samplers into one steadily rising percentage", () => {
    let jobs = [running({ stages: 2 })];
    const seen: Array<number | null> = [];
    for (const [node, value] of [["a", 1], ["a", 2], ["b", 1], ["b", 2]] as const) {
      jobs = tick(jobs, node, value, 2);
      seen.push(jobs[0].progress);
    }
    expect(seen).toEqual([25, 50, 75, 100]);
  });

  it("behaves as before for a single sampler", () => {
    const jobs = tick([running()], "3", 5, 20);
    expect(jobs[0].progress).toBe(25);
  });

  it("counts samplers from a graph", async () => {
    const { countSamplers } = await import("../src/jobs/server");
    expect(countSamplers(wan.template)).toBe(1);
    const fourteen = providers.find((p) => p.id === "wan22-i2v-14b")!;
    expect(countSamplers(fourteen.template)).toBe(2);
  });
});

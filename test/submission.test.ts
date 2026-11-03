import { describe, expect, it, vi } from "vitest";
import { acceptSubmission, cancellationAfterFailure } from "../src/jobs/submission";
import { jobsReducer } from "../src/jobs/machine";
import type { Job } from "../src/jobs/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const job = (status: Job["status"] = "uploading"): Job => ({
  id: "local", status, progress: null, queuePosition: null, providerId: "provider",
  model: "model", resolution: "480p", createdAt: 1, thumb: null,
  params: { prompt: "scene", negative: "", startImage: "", aspect: "landscape", durationSec: 3, seed: 7 },
});

describe("accepting a submission while cancellation is pending", () => {
  function setup(cancelRemote = vi.fn(async (_id: string) => true)) {
    const request = deferred<string>();
    const cancelled = new Set<string>();
    const accept = vi.fn(), recordAccepted = vi.fn(), confirmCancellation = vi.fn(), resumeTracking = vi.fn();
    const pending = acceptSubmission({
      localId: "local", submit: () => request.promise, cancelled, accept, recordAccepted, cancelRemote, confirmCancellation, resumeTracking,
    });
    return { request, cancelled, accept, recordAccepted, cancelRemote, confirmCancellation, resumeTracking, pending };
  }

  it("accepts an ordinary request without canceling anything", async () => {
    const s = setup(); s.request.resolve("server-1");
    expect(await s.pending).toBe("server-1");
    expect(s.accept).toHaveBeenCalledWith("server-1");
    expect(s.recordAccepted).toHaveBeenCalledWith("server-1");
    expect(s.cancelRemote).not.toHaveBeenCalled();
  });

  it("targets only the new server ID when cancellation happens during the deferred request", async () => {
    const s = setup(); s.cancelled.add("unrelated"); s.cancelled.add("local");
    s.request.resolve("server-1"); await s.pending;
    expect(s.cancelRemote).toHaveBeenCalledOnce();
    expect(s.cancelRemote).toHaveBeenCalledWith("server-1");
    expect(s.accept.mock.invocationCallOrder[0]).toBeLessThan(s.cancelRemote.mock.invocationCallOrder[0]);
    expect(s.confirmCancellation).toHaveBeenCalledOnce();
    expect(s.resumeTracking).not.toHaveBeenCalled();
    expect([...s.cancelled]).toEqual(["unrelated"]);
  });

  it("resumes reconciliation if the server says it did not cancel the job", async () => {
    const s = setup(vi.fn(async (_id: string) => false)); s.cancelled.add("local");
    s.request.resolve("server-2"); await s.pending;
    expect(s.confirmCancellation).not.toHaveBeenCalled();
    expect(s.resumeTracking).toHaveBeenCalledOnce();
    expect(s.resumeTracking).toHaveBeenCalledWith("server-2");
  });

  it("keeps the accepted ID observable if the cancel request fails", async () => {
    const s = setup(vi.fn(async (_id: string): Promise<boolean> => { throw new Error("offline"); }));
    s.cancelled.add("local"); s.request.resolve("server-3"); await s.pending;
    expect(s.accept).toHaveBeenCalledWith("server-3");
    expect(s.confirmCancellation).not.toHaveBeenCalled();
    expect(s.resumeTracking).toHaveBeenCalledWith("server-3");
    expect(s.cancelled.size).toBe(0);
  });

  it("does not let a run-record failure block accepted-job cancellation", async () => {
    const s = setup();
    s.recordAccepted.mockImplementation(() => { throw new Error("storage blocked"); });
    s.cancelled.add("local");
    s.request.resolve("server-4");
    await expect(s.pending).resolves.toBe("server-4");
    expect(s.accept).toHaveBeenCalledWith("server-4");
    expect(s.cancelRemote).toHaveBeenCalledWith("server-4");
    expect(s.confirmCancellation).toHaveBeenCalledOnce();
  });

  it("does not accept or cancel a rejected submission and leaves failure cleanup to its caller", async () => {
    const s = setup(); s.cancelled.add("local");
    s.request.reject(new Error("validation"));
    await expect(s.pending).rejects.toThrow("validation");
    expect(s.accept).not.toHaveBeenCalled(); expect(s.cancelRemote).not.toHaveBeenCalled();
    expect(cancellationAfterFailure(s.cancelled, "local", true, true)).toBe("cancelled");
    expect(s.cancelled.size).toBe(0);
  });

  it("does not revive a locally cancelled job on accept or an older queue snapshot", () => {
    const accepted = jobsReducer([job("cancelled")], { type: "accepted", id: "local", promptId: "server-1" });
    expect(accepted[0]).toMatchObject({ status: "cancelled", promptId: "server-1" });
    expect(jobsReducer(accepted, { type: "synced", jobs: [{ ...job("queued"), id: "server-1", promptId: "server-1" }] })[0].status).toBe("cancelled");
  });

  it.each(["running", "done", "failed"] as const)("does not move an already %s job backwards on accept", (status) => {
    expect(jobsReducer([job(status)], { type: "accepted", id: "local", promptId: "server" })[0]).toMatchObject({ status, promptId: "server" });
  });

  it("promotes an ordinary upload to queued", () => {
    expect(jobsReducer([job()], { type: "accepted", id: "local", promptId: "server" })[0].status).toBe("queued");
  });
});

describe("cancellation bookkeeping on failure", () => {
  it("keeps a cancelled upload cancelled and clears its marker", () => {
    const cancelled = new Set(["local"]);
    expect(cancellationAfterFailure(cancelled, "local", false, false)).toBe("cancelled");
    expect(cancelled.size).toBe(0);
  });
  it("labels a lost submission response unknown rather than confirmed cancelled", () => {
    const cancelled = new Set(["local"]);
    expect(cancellationAfterFailure(cancelled, "local", true, false)).toBe("unknown");
    expect(cancelled.size).toBe(0);
  });
  it("does not suppress an ordinary failure or consume another job's intent", () => {
    const cancelled = new Set(["other"]);
    expect(cancellationAfterFailure(cancelled, "local", true, true)).toBe("none");
    expect([...cancelled]).toEqual(["other"]);
  });
});

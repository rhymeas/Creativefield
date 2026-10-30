// The job list as a pure reducer. Everything that can change a job goes through here, so the
// rules (a job never moves backwards, a server snapshot never erases a local job) are testable.

import type { ComfyEvent } from "../comfy/client";
import { isActive, type Job, type JobStatus } from "./types";

export type JobAction =
  | { type: "add"; job: Job }
  /** ComfyUI accepted the job. */
  | { type: "accepted"; id: string; promptId: string }
  | { type: "patch"; id: string; patch: Partial<Job> }
  /** A live message from ComfyUI's WebSocket. */
  | { type: "event"; event: ComfyEvent }
  /** A snapshot of what ComfyUI knows: history and queue, already converted to jobs. */
  | { type: "synced"; jobs: Job[] };

/** A job only moves forward: uploading, queued, running, then one of the finished states. */
const RANK: Record<JobStatus, number> = { uploading: 0, queued: 1, running: 2, done: 3, failed: 3, cancelled: 3 };

export function sortJobs(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => b.createdAt - a.createdAt);
}

function update(jobs: Job[], match: (j: Job) => boolean, change: (j: Job) => Job): Job[] {
  return jobs.map((j) => (match(j) ? change(j) : j));
}

export function jobsReducer(jobs: Job[], action: JobAction): Job[] {
  switch (action.type) {
    case "add":
      return sortJobs([action.job, ...jobs.filter((j) => j.id !== action.job.id)]);

    case "accepted":
      return update(jobs, (j) => j.id === action.id, (j) => ({
        ...j,
        promptId: action.promptId,
        status: j.status === "uploading" ? "queued" : j.status,
      }));

    case "patch":
      return update(jobs, (j) => j.id === action.id, (j) => ({ ...j, ...action.patch }));

    case "event": {
      const e = action.event;
      if (!e.promptId) return jobs;
      const mine = (j: Job) => j.promptId === e.promptId && isActive(j.status);
      switch (e.type) {
        case "progress":
          return update(jobs, mine, (j) => {
            if (e.max <= 0) return { ...j, status: "running", queuePosition: null, progress: null };
            // One bar for the whole job: each sampler contributes its own fraction.
            const stageProgress = { ...j.stageProgress, [e.node ?? ""]: e.value / e.max };
            const finished = Object.values(stageProgress).reduce((a, b) => a + b, 0);
            const stages = Math.max(j.stages ?? 1, Object.keys(stageProgress).length);
            return {
              ...j,
              status: "running",
              queuePosition: null,
              stageProgress,
              progress: Math.min(100, Math.round((finished / stages) * 100)),
            };
          });
        case "executing":
          return e.node === null ? jobs : update(jobs, mine, (j) => ({ ...j, status: "running", queuePosition: null }));
        case "execution_error":
          return update(jobs, mine, (j) => ({
            ...j,
            status: "failed",
            progress: null,
            errorTitle: "ComfyUI stopped the job",
            errorLines: [e.message],
          }));
        case "interrupted":
          return update(jobs, mine, (j) => ({ ...j, status: "cancelled", progress: null, queuePosition: null }));
        default:
          return jobs;
      }
    }

    case "synced": {
      let next = jobs;
      for (const server of action.jobs) {
        const local = next.find((j) => j.promptId === server.promptId);
        if (!local) {
          next = [...next, server];
          continue;
        }
        // Never move a job backwards because a snapshot was taken a moment earlier.
        if (RANK[server.status] < RANK[local.status]) continue;
        next = update(next, (j) => j === local, (j) => ({
          ...j,
          status: server.status,
          queuePosition: server.queuePosition,
          // The server does not know sampling progress; keep what the WebSocket reported.
          progress: server.status === "running" ? (j.status === "running" ? j.progress : null) : server.progress,
          output: server.output ?? j.output,
          errorTitle: server.errorTitle,
          errorLines: server.errorLines,
          runMs: server.runMs ?? j.runMs,
        }));
      }
      return sortJobs(next);
    }
  }
}

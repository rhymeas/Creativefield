import type { OutputFile } from "../comfy/client";
import type { RecoveredParams } from "../pipelines/recover";

export type JobStatus = "uploading" | "queued" | "running" | "done" | "failed" | "cancelled";

export const isActive = (s: JobStatus) => s === "uploading" || s === "queued" || s === "running";
export const isFinished = (s: JobStatus) => !isActive(s);

export type Job = {
  /** A local ID until ComfyUI accepts the job; the prompt ID for jobs that came from the server. */
  id: string;
  /** "enhance" for an upscale of a finished clip. Anything else (or absent) is a generation. */
  kind?: "generate" | "enhance";
  /** For an enhance job: what it was made from. */
  enhance?: { factor: number; sourceVideo: string; sourceJobId?: string };
  promptId?: string;
  status: JobStatus;
  /** 0 to 100 while running; null when ComfyUI has not reported any yet (for example after a reload). */
  progress: number | null;
  /**
   * How many sampler passes the graph runs. A two-stage model (Wan 2.2 14B uses a high-noise and a
   * low-noise sampler) reports 0 to 100 percent twice; the studio folds them into one. Default 1.
   */
  stages?: number;
  /** Each sampler's latest progress as a fraction, by node ID. Bookkeeping for `progress`. */
  stageProgress?: Record<string, number>;
  /** Place in the pending queue while queued: 1 is the next job to run. */
  queuePosition: number | null;
  providerId: string;
  /** Short model name and resolution label, copied from the manifest for display. */
  model: string;
  resolution: string;
  params: RecoveredParams;
  /** A blob URL for jobs made in this page session; otherwise recovered from the input folder. */
  thumb: { kind: "blob"; url: string } | { kind: "input"; filename: string } | null;
  /** The driving video of a motion-control job, shown next to the character image. */
  motionThumb?: { kind: "blob"; url: string } | { kind: "input"; filename: string } | null;
  /** The last frame of a first-and-last-frame job. */
  endThumb?: { kind: "blob"; url: string } | { kind: "input"; filename: string } | null;
  output?: OutputFile;
  errorTitle?: string;
  errorLines?: string[];
  /** Milliseconds since the epoch. */
  createdAt: number;
  /** How long ComfyUI spent running the job, when known. */
  runMs?: number;
};

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { PromptRejectedError, type ComfyClient, type ComfyEvent } from "../comfy/client";
import type { RecoveredParams } from "../pipelines/recover";
import { readParams } from "../pipelines/recover";
import type { Enhancer, Provider } from "../pipelines/registry";
import type { AcceptedRunInput } from "../runs/records";
import { buildGraph } from "../workflow/build";
import { buildEnhanceGraph } from "../workflow/enhance";
import { explainPromptError } from "../workflow/prompt-errors";
import { jobsReducer } from "./machine";
import { countSamplers, jobFromHistory, jobsFromHistory, jobsFromQueue, type EnhanceMeta } from "./server";
import { isActive, type Job } from "./types";
import { acceptSubmission, cancellationAfterFailure } from "./submission";

const PAGE = 30; // history entries fetched at a time
const POLL_MS = 2500; // how often active jobs are checked against the queue

export type EnhanceInput = {
  enhancer: Enhancer;
  /** A finished job whose video is to be enlarged. */
  source: Job;
  /** The final enlargement, for example 2. */
  factor: number;
};

export type SubmitInput = {
  provider: Provider;
  /** The start image. Null for text to video. */
  file: File | null;
  /** A blob URL of the chosen image, shown as the thumbnail until the page is reloaded. */
  previewUrl: string | null;
  /** The last frame, for first-and-last-frame video. Null otherwise. */
  endFile?: File | null;
  endPreviewUrl?: string | null;
  /** The driving video, for motion control. Null otherwise. */
  motionFile?: File | null;
  motionPreviewUrl?: string | null;
  params: Pick<RecoveredParams, "prompt" | "negative" | "aspect" | "durationSec" | "seed" | "motionPrompt">;
};

/**
 * The studio's jobs. ComfyUI is the source of truth: the list is rebuilt from its history and
 * queue on load and whenever the connection returns, so a page reload loses nothing. Live
 * events from the WebSocket only make it faster (progress, instant completion).
 */
export function useJobs({
  client,
  providers,
  enhancers = [],
  connected,
  subscribe,
  onAcceptedRun,
}: {
  client: ComfyClient;
  providers: Provider[];
  enhancers?: Enhancer[];
  connected: boolean;
  subscribe: (listener: (e: ComfyEvent) => void) => () => void;
  onAcceptedRun?: (promptId: string, input: AcceptedRunInput) => void;
}) {
  const [jobs, dispatch] = useReducer(jobsReducer, []);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const nextOffset = useRef(PAGE);
  const cancelledBeforeSubmit = useRef(new Set<string>());
  /** How many checks in a row found no trace of an active job in ComfyUI's queue or history. */
  const missing = useRef(new Map<string, number>());

  /** Reads history and queue from ComfyUI and merges them into the list. */
  const refresh = useCallback(async () => {
    try {
      const [history, queue] = await Promise.all([client.listHistory(PAGE, 0), client.queue()]);
      dispatch({ type: "synced", jobs: [...jobsFromQueue(queue, providers, enhancers), ...jobsFromHistory(history, providers, enhancers)] });
      if (nextOffset.current === PAGE) setHasMore(Object.keys(history).length === PAGE);
      setLoaded(true);
    } catch {
      // ComfyUI is unreachable; the list keeps what it has and refreshes when the connection returns.
    }
  }, [client, providers, enhancers]);

  useEffect(() => {
    void refresh();
  }, [refresh, connected]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const history = await client.listHistory(PAGE, nextOffset.current);
      nextOffset.current += PAGE;
      dispatch({ type: "synced", jobs: jobsFromHistory(history, providers, enhancers) });
      setHasMore(Object.keys(history).length === PAGE);
    } finally {
      setLoadingMore(false);
    }
  }, [client, providers, enhancers]);

  /** Looks up one job that has left the queue, to learn how it ended. Returns whether ComfyUI knew it. */
  const settle = useCallback(
    async (promptId: string): Promise<boolean> => {
      try {
        const entry = await client.history(promptId);
        const job = entry && jobFromHistory(promptId, entry, providers, enhancers);
        if (job) dispatch({ type: "synced", jobs: [job] });
        return !!entry;
      } catch {
        return true; // could not ask; do not conclude anything, try again on the next poll
      }
    },
    [client, providers, enhancers],
  );

  // Live events: progress and failures go to the reducer; the end of a prompt triggers a lookup.
  useEffect(
    () =>
      subscribe((event) => {
        dispatch({ type: "event", event });
        if (event.promptId && (event.type === "executing" ? event.node === null : event.type === "executed")) {
          void settle(event.promptId);
        }
      }),
    [subscribe, settle],
  );

  // While something is active, check the queue now and then. This gives queue positions, and it
  // also catches the end of a job if a WebSocket message was missed (or the page was reloaded).
  const watching = jobs.some((j) => isActive(j.status) && j.promptId);
  useEffect(() => {
    if (!watching) return;
    const tick = async () => {
      try {
        const queue = await client.queue();
        const inQueue = jobsFromQueue(queue, providers, enhancers);
        dispatch({ type: "synced", jobs: inQueue });
        const stillThere = new Set(inQueue.map((j) => j.promptId));
        for (const j of jobsRef.current) {
          if (!isActive(j.status) || !j.promptId || stillThere.has(j.promptId)) continue;
          const promptId = j.promptId;
          void settle(promptId).then((known) => {
            if (known) return void missing.current.delete(promptId);
            // ComfyUI keeps its history in memory, so a restart wipes it. A job that is in neither
            // the queue nor the history for a few checks in a row is gone, not slow.
            const misses = (missing.current.get(promptId) ?? 0) + 1;
            missing.current.set(promptId, misses);
            if (misses >= 3) {
              missing.current.delete(promptId);
              dispatch({
                type: "patch",
                id: j.id,
                patch: {
                  status: "failed",
                  progress: null,
                  queuePosition: null,
                  errorTitle: "ComfyUI lost this job",
                  errorLines: ["ComfyUI has no record of it. It was probably restarted while the job ran. Start it again."],
                },
              });
            }
          });
        }
      } catch {
        /* offline: try again next tick */
      }
    };
    const id = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(id);
  }, [watching, client, providers, enhancers, settle]);

  const submit = useCallback(
    async ({ provider, file, previewUrl, endFile, endPreviewUrl, motionFile, motionPreviewUrl, params }: SubmitInput) => {
      const id = crypto.randomUUID();
      const { manifest, template } = provider;
      const createdAt = Date.now();
      let submitting = false;
      dispatch({
        type: "add",
        job: {
          id,
          status: "uploading",
          progress: null,
          queuePosition: null,
          providerId: provider.id,
          model: manifest.display.short,
          resolution: manifest.display.resolution,
          params: { ...params, startImage: file?.name ?? "", endImage: endFile?.name ?? "", motionVideo: motionFile?.name ?? "" },
          stages: countSamplers(template),
          thumb: previewUrl ? { kind: "blob", url: previewUrl } : null,
          endThumb: endPreviewUrl ? { kind: "blob", url: endPreviewUrl } : null,
          motionThumb: motionPreviewUrl ? { kind: "blob", url: motionPreviewUrl } : null,
          createdAt,
        },
      });
      try {
        const uploaded = file ? await client.uploadImage(file) : undefined;
        const uploadedEnd = endFile && provider.manifest.inputs.end_image ? await client.uploadImage(endFile) : undefined;
        const uploadedMotion = motionFile && provider.manifest.inputs.motion_video ? await client.uploadImage(motionFile) : undefined;
        if (cancelledBeforeSubmit.current.delete(id)) return; // cancelled while uploading: do not queue it
        dispatch({ type: "patch", id, patch: { params: { ...params, startImage: uploaded ?? "", endImage: uploadedEnd ?? "", motionVideo: uploadedMotion ?? "" } } });
        const graph = buildGraph(template, manifest, {
          prompt: params.prompt,
          negative: params.negative,
          startImage: uploaded,
          endImage: uploadedEnd,
          motionVideo: uploadedMotion,
          motionPrompt: params.motionPrompt,
          resolution: params.aspect,
          durationSec: params.durationSec,
          seed: params.seed,
        });
        const acceptedRun: AcceptedRunInput = {
          providerId: provider.id,
          pipeline: provider.pipeline,
          kind: "generate",
          model: manifest.display.short,
          resolution: manifest.display.resolution,
          execution: manifest.execution ?? { route: "unknown" },
          effectiveParams: readParams(graph, manifest),
          createdAt,
          graph,
          manifest,
        };
        submitting = true;
        await acceptSubmission({
          localId: id,
          submit: () => client.submitPrompt(graph),
          cancelled: cancelledBeforeSubmit.current,
          accept: (promptId) => dispatch({ type: "accepted", id, promptId }),
          recordAccepted: (promptId) => onAcceptedRun?.(promptId, acceptedRun),
          cancelRemote: (promptId) => client.cancelJob(promptId),
          confirmCancellation: () => dispatch({ type: "patch", id, patch: { status: "cancelled", progress: null, queuePosition: null } }),
          resumeTracking: (promptId) => {
            dispatch({ type: "patch", id, patch: { status: "queued", progress: null, queuePosition: null } });
            void settle(promptId);
          },
        });
        void refresh(); // learn the queue position straight away
      } catch (e) {
        const cancellation = cancellationAfterFailure(cancelledBeforeSubmit.current, id, submitting, e instanceof PromptRejectedError && e.status === 400);
        if (cancellation === "cancelled") return;
        if (cancellation === "unknown") {
          dispatch({ type: "patch", id, patch: { status: "failed", errorTitle: "Submission status unknown", errorLines: ["ComfyUI did not return a job ID. Cancellation could not be confirmed. Inspect the server queue before retrying."] } });
          return;
        }
        if (e instanceof PromptRejectedError) {
          const why = explainPromptError(e.rejection, manifest, template);
          dispatch({ type: "patch", id, patch: { status: "failed", errorTitle: why.title, errorLines: why.lines } });
        } else {
          dispatch({ type: "patch", id, patch: { status: "failed", errorTitle: "Generation failed", errorLines: [(e as Error).message] } });
        }
      }
    },
    [client, refresh, settle, onAcceptedRun],
  );

  /** Enlarges a finished clip. The clip is copied from ComfyUI's output folder into its input folder first. */
  const enhance = useCallback(
    async ({ enhancer, source, factor }: EnhanceInput) => {
      const id = crypto.randomUUID();
      const createdAt = Date.now();
      let submitting = false;
      dispatch({
        type: "add",
        job: {
          id,
          kind: "enhance",
          status: "uploading",
          progress: null,
          queuePosition: null,
          providerId: enhancer.id,
          model: `${enhancer.manifest.display.short} ${factor}×`,
          resolution: `${factor}× larger`,
          params: source.params,
          stages: 1,
          thumb: null,
          enhance: { factor, sourceVideo: "", sourceJobId: source.promptId },
          createdAt,
        },
      });
      try {
        if (!source.output) throw new Error("The clip has no video file to enlarge");
        const clip = await (await fetch(client.viewUrl(source.output))).blob();
        const sourceVideo = await client.uploadImage(
          new File([clip], `clip-${(source.promptId ?? source.id).slice(0, 8)}.mp4`, { type: clip.type || "video/mp4" }),
        );
        if (cancelledBeforeSubmit.current.delete(id)) return; // cancelled while uploading: do not queue it
        dispatch({ type: "patch", id, patch: { enhance: { factor, sourceVideo, sourceJobId: source.promptId } } });
        const graph = buildEnhanceGraph(enhancer.template, enhancer.manifest, { sourceVideo, factor });
        const meta: EnhanceMeta = { kind: "enhance", sourceJobId: source.promptId, sourceParams: source.params };
        const acceptedRun: AcceptedRunInput = {
          providerId: enhancer.id,
          pipeline: enhancer.pipeline,
          kind: "enhance",
          model: `${enhancer.manifest.display.short} ${factor}×`,
          resolution: `${factor}× larger`,
          execution: enhancer.manifest.execution ?? { route: "unknown" },
          effectiveParams: structuredClone(source.params),
          createdAt,
          graph,
          manifest: enhancer.manifest,
          enhance: { factor, sourceVideo, sourceJobId: source.promptId },
        };
        submitting = true;
        await acceptSubmission({
          localId: id,
          submit: () => client.submitPrompt(graph, { studio: meta }),
          cancelled: cancelledBeforeSubmit.current,
          accept: (promptId) => dispatch({ type: "accepted", id, promptId }),
          recordAccepted: (promptId) => onAcceptedRun?.(promptId, acceptedRun),
          cancelRemote: (promptId) => client.cancelJob(promptId),
          confirmCancellation: () => dispatch({ type: "patch", id, patch: { status: "cancelled", progress: null, queuePosition: null } }),
          resumeTracking: (promptId) => {
            dispatch({ type: "patch", id, patch: { status: "queued", progress: null, queuePosition: null } });
            void settle(promptId);
          },
        });
        void refresh();
      } catch (e) {
        const cancellation = cancellationAfterFailure(cancelledBeforeSubmit.current, id, submitting, e instanceof PromptRejectedError && e.status === 400);
        if (cancellation === "cancelled") return;
        if (cancellation === "unknown") {
          dispatch({ type: "patch", id, patch: { status: "failed", errorTitle: "Submission status unknown", errorLines: ["ComfyUI did not return a job ID. Cancellation could not be confirmed. Inspect the server queue before retrying."] } });
          return;
        }
        if (e instanceof PromptRejectedError) {
          const lines = Object.values(e.rejection.node_errors).flatMap((n) => n.errors.map((x) => `${n.class_type ?? "node"}: ${x.message}${x.details ? ` (${x.details})` : ""}`));
          dispatch({ type: "patch", id, patch: { status: "failed", errorTitle: "ComfyUI could not start the upscale", errorLines: lines.length ? lines : [e.message] } });
        } else {
          dispatch({ type: "patch", id, patch: { status: "failed", errorTitle: "Upscale failed", errorLines: [(e as Error).message] } });
        }
      }
    },
    [client, refresh, settle, onAcceptedRun],
  );

  const cancel = useCallback(
    async (job: Job) => {
      const cancelled = { status: "cancelled" as const, progress: null, queuePosition: null };
      if (!job.promptId) {
        cancelledBeforeSubmit.current.add(job.id);
        dispatch({ type: "patch", id: job.id, patch: cancelled });
        return;
      }
      try {
        if (await client.cancelJob(job.promptId)) dispatch({ type: "patch", id: job.id, patch: cancelled });
        else void settle(job.promptId); // it had already finished
      } catch {
        /* could not reach ComfyUI; the job stays as it is */
      }
    },
    [client, settle],
  );

  return { jobs, loaded, hasMore, loadingMore, submit, enhance, cancel, loadMore, refresh };
}

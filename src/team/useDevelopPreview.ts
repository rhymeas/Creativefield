import { useEffect, useState } from "react";
import { request, workspacePath, type Run } from "./api";
import { DEVELOP_LIVE_STATES } from "./develop-state";

export type DevelopPreview = {
  active: boolean;
  waiting?:"memory";
  /** Why the run waits, in numbers: how much RAM is free and how much it needs. */
  waitingNote?:string;
  preview: boolean;
  value: number | null;
  max: number | null;
  node: string | null;
  /** The stage the server names for this step: preparing, thinking, working, rendering, upscaling. */
  stage?: string;
  /** Which part of a job made in parts, and how many parts there are. */
  part?: number;
  parts?: number;
  seq: number;
  updatedAt: string | null;
};

/** Latest real preview frame and step progress for one run. Server keeps frames in memory only. */
export function useDevelopPreview(workspaceId: string, run: Pick<Run, "id" | "state"> | undefined): DevelopPreview | null {
  const live = !!run && DEVELOP_LIVE_STATES.has(run.state);
  const visible = live || run?.state === "failed" || run?.state === "canceled";
  const runId = run?.id;
  const [state, setState] = useState<{ workspaceId: string; runId: string; frame: DevelopPreview } | null>(null);

  useEffect(() => {
    if (!runId || !visible) return;
    let canceled = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await request<DevelopPreview>(workspacePath(workspaceId, `runs/${encodeURIComponent(runId)}/develop`), "GET", undefined, abort.signal);
        if (canceled) return;
        setState({ workspaceId, runId, frame: next });
        if (!live || !next.active) return;
      } catch {
        if (canceled) return;
      }
      if (!canceled && live) timer = setTimeout(poll, 700);
    };
    void poll();
    return () => {
      canceled = true;
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [workspaceId, runId, live, visible]);

  return visible && state?.workspaceId === workspaceId && state.runId === runId ? state.frame : null;
}

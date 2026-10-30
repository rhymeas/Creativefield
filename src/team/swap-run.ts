/* Swap a thing: the run loop behind Generate. One press of Generate is one attempt: every step of that attempt
   gets its own idempotency key, so pressing Generate again queues a new run instead of fetching the old failed
   one. Each step says what it is doing, a failure names the step that failed, and the run in flight can be
   cancelled. No UI here, so the whole loop is testable without a browser. */
import {workspacePath, type Call, type Run} from "./api";
import {activeRun} from "./state";
import type {SwapStep} from "./swap-thing";

/** A step that carries its own words for the server (the mask step sends a tracking prompt, not a control). */
export type TrackedStep = SwapStep & {tracking?: Record<string, unknown>};

/** What the step is doing, in the panel: "Find the red car…". */
export function stepLabel(step: SwapStep): string { return `${step.label}…`; }

/** One key per attempt and step. Pressing Generate again bumps the attempt, so a retry queues a new run;
 *  editing an input never changes a key that is already in flight. */
export function attemptKey(attempt: number, stepId: string): string { return `swap-${attempt}-${stepId}`; }

export type SwapStepBody = {
  projectId: string; workerId: string; idempotencyKey: string; capabilityId: string; version: string;
  routeId: "local"; inputs: Record<string, string>; elementInputs: Record<string, never>;
  controls: Record<string, unknown>; audioPolicy: "mute"; tracking?: Record<string, unknown>;
};

/** The body the server takes for one step of one attempt. */
export function swapStepBody(step: TrackedStep, inputs: Record<string, string>, target: {projectId: string; workerId: string; attempt: number}): SwapStepBody {
  return {
    projectId: target.projectId, workerId: target.workerId, idempotencyKey: attemptKey(target.attempt, step.id),
    capabilityId: step.capabilityId, version: step.version, routeId: "local",
    inputs, elementInputs: {}, controls: step.controls, audioPolicy: "mute",
    ...(step.tracking ? {tracking: step.tracking} : {}),
  };
}

/** A step that came back without its picture or clip, named in plain words. */
export class SwapStepError extends Error {
  constructor(readonly stepId: string, readonly label: string, reason: string) {
    super(`${label}: ${reason}`);
    this.name = "SwapStepError";
  }
}

/** Why a run stopped, as a sentence. */
export function swapStopReason(run: Pick<Run, "state" | "error">): string {
  const error = run.error?.trim();
  if (error) return error;
  return ["canceled", "cancel_requested"].includes(run.state) ? "it was cancelled." : "it did not finish.";
}

export type SwapAttempt = {
  call: Call; workspaceId: string; projectId: string; workerId: string;
  /** Which press of Generate this is: 1 for the first, 2 for a retry. */
  attempt: number; steps: TrackedStep[];
  /** The step now working, or "" when the attempt ends. */
  onStep?: (label: string) => void;
  /** The run that Cancel stops, or null when nothing is in flight. */
  onRun?: (runId: string | null) => void;
  /** Called after each queue and each check, so panels refresh their lists. */
  onChanged?: () => void;
  /** How long to wait between checks, and the wait itself (tests pass an instant one). */
  waitMs?: number; sleep?: (ms: number) => Promise<void>;
  /** False once the panel is closed, so the loop stops without an error. */
  alive?: () => boolean;
};

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Queue the steps in order, feed each step's output into the next, and return step id → output asset.
 *  Throws a `SwapStepError` naming the step that did not finish. */
export async function runSwapAttempt({call, workspaceId, projectId, workerId, attempt, steps,
  onStep, onRun, onChanged, waitMs = 3000, sleep = wait, alive = () => true}: SwapAttempt): Promise<Record<string, string>> {
  const outputs: Record<string, string> = {};
  try {
    for (const step of steps) {
      onStep?.(stepLabel(step));
      const inputs = Object.fromEntries(Object.entries(step.inputs).map(([key, value]) => [key, "asset" in value ? value.asset : outputs[value.step]]));
      let run = await call<Run>(workspacePath(workspaceId, "runs"), "POST", swapStepBody(step, inputs, {projectId, workerId, attempt}));
      onRun?.(run.id);
      onChanged?.();
      while (activeRun(run.state) && alive()) {
        await sleep(waitMs);
        run = await call<Run>(workspacePath(workspaceId, `runs/${encodeURIComponent(run.id)}`), "GET");
      }
      if (!alive()) return outputs;
      if (run.state !== "succeeded") throw new SwapStepError(step.id, step.label, swapStopReason(run));
      const output = run.output_ids[0];
      if (!output) throw new SwapStepError(step.id, step.label, "nothing came back. Try other words.");
      outputs[step.id] = output;
      onChanged?.();
    }
    return outputs;
  } finally {
    onRun?.(null);
    onStep?.("");
  }
}

/** Stop the run that is working. The server asks the worker; the loop sees the state on its next check. */
export async function cancelSwapRun(call: Call, workspaceId: string, runId: string): Promise<void> {
  await call(workspacePath(workspaceId, `runs/${encodeURIComponent(runId)}/cancel`), "POST", {});
}

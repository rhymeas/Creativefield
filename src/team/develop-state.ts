import type { DevelopPreview } from "./useDevelopPreview";

export const DEVELOP_LIVE_STATES = new Set([
  "pending", "submitting", "submission_unknown", "queued", "running", "cancel_requested",
]);

/** What a running job is doing, in plain words, when the server names its stage. */
const STAGE_WORDS: Record<string, string> = { preparing: "Getting ready", thinking: "Thinking", working: "Working on it", rendering: "Rendering", upscaling: "Sharpening" };

/** Presentation follows the ledger; requesting cancellation is not confirmation. */
export function developPresentation(state: string, frame: DevelopPreview | null, previewUrl?: string) {
  const terminal = state === "failed" || state === "canceled";
  if (!terminal && !DEVELOP_LIVE_STATES.has(state)) return undefined;
  const steps = frame?.value != null && frame.max != null && frame.max > 0
    ? `${frame.value}/${frame.max}` : undefined;
  const label = state === "cancel_requested" ? "Cancelling…"
    : terminal ? `${state === "failed" ? "Failed" : "Cancelled"}${steps ? ` at step ${steps}` : ""}`
    : state === "submission_unknown" ? "Checking submission"
    : state === "pending" && frame?.waiting === "memory" ? `Waiting for free memory${frame.waitingNote ? ` · ${frame.waitingNote}` : ""}`
    : state === "pending" || state === "queued" ? "Queued"
    : `${frame?.stage ? STAGE_WORDS[frame.stage] : "Working on it"}${frame?.part && frame?.parts && frame.parts > 1 ? ` · part ${frame.part} of ${frame.parts}` : ""}${steps ? ` · ${steps}` : ""}`;
  return {
    ...(frame?.preview && previewUrl ? { src: previewUrl } : {}),
    label,
    detail: undefined,
    progress: steps ? Math.min(1, Math.max(0, frame!.value! / frame!.max!)) : undefined,
    active: !terminal,
  };
}

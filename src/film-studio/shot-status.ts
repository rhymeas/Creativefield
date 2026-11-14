/*
 * The per-shot analysis state: one field and one transition function, not a
 * bundle of booleans. Two rules are product requirements, not conventions:
 *
 * 1. A new analysis never overwrites a shot the person has edited
 *    (`edited` only leaves the state on an explicit re-analysis request).
 * 2. A geometry error never deletes the rough blockout: `refining` falls back to
 *    `blockout`, not to `pending`, so the heuristic score stays visible.
 */
export type ShotStatus = "pending" | "blockout" | "refining" | "spatial" | "edited";

export const SHOT_STATUSES: readonly ShotStatus[] = ["pending", "blockout", "refining", "spatial", "edited"];

export type ShotStatusEvent =
  | "cutDetected"
  | "blockoutReady"
  | "refineStarted"
  | "geometryReady"
  | "geometryFailed"
  | "userEdited"
  | "reanalyze";

/** The one transition function. Unknown input states stay as they are. */
export function nextShotStatus(status: ShotStatus, event: ShotStatusEvent): ShotStatus {
  // An edit wins over every automatic event; only an explicit re-analysis may leave it.
  if (status === "edited") return event === "reanalyze" ? "refining" : "edited";
  switch (event) {
    case "cutDetected":
      return status === "pending" ? "blockout" : status;
    case "blockoutReady":
      return status === "pending" ? "blockout" : status;
    case "refineStarted":
      return status === "pending" || status === "blockout" || status === "spatial" ? "refining" : status;
    case "geometryReady":
      return status === "refining" || status === "blockout" ? "spatial" : status;
    case "geometryFailed":
      // Never delete the rough blockout: refining falls back to the heuristic state.
      return status === "refining" ? "blockout" : status;
    case "userEdited":
      return status === "pending" ? "pending" : "edited";
    case "reanalyze":
      return status === "spatial" || status === "refining" ? "refining" : status;
    default:
      return status;
  }
}

/** Apply one event to many shots (all shots, or only the named indices). */
export function applyShotEvent(statuses: readonly ShotStatus[], event: ShotStatusEvent, indices?: readonly number[]): ShotStatus[] {
  const target = indices ? new Set(indices) : null;
  return statuses.map((status, index) => (target && !target.has(index) ? status : nextShotStatus(status, event)));
}

/** A fresh clip: every detected shot starts as a rough blockout until a batch refines it. */
export function initialShotStatuses(count: number): ShotStatus[] {
  return Array.from({length: Math.max(0, count)}, () => "blockout" as ShotStatus);
}

/** True when an automatic analysis result may replace this shot's data. */
export function acceptsAutomaticAnalysis(status: ShotStatus): boolean {
  return status !== "edited";
}

/** The staff-facing word for the shot card, short enough for a Meta line. */
export function shotStatusLabel(status: ShotStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "blockout":
      return "Rough";
    case "refining":
      return "Measuring";
    case "spatial":
      return "Measured";
    case "edited":
      return "Edited";
    default:
      return "Unknown";
  }
}

/** How much of the clip is measured; used for the one progress sentence, never a progress bar. */
export function measuredCount(statuses: readonly ShotStatus[]): number {
  return statuses.filter((status) => status === "spatial" || status === "edited").length;
}

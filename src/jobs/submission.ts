/** Consume cancellation on a failed attempt, without claiming an ambiguous submission was stopped. */
export function cancellationAfterFailure(
  cancelled: Set<string>,
  localId: string,
  submitting: boolean,
  definitelyRejected: boolean,
): "none" | "cancelled" | "unknown" {
  if (!cancelled.delete(localId)) return "none";
  return !submitting || definitelyRejected ? "cancelled" : "unknown";
}

/** Attach a server ID before resolving a cancellation requested while submission was in flight. */
export async function acceptSubmission({
  localId,
  submit,
  cancelled,
  accept,
  recordAccepted,
  cancelRemote,
  confirmCancellation,
  resumeTracking,
}: {
  localId: string;
  submit: () => Promise<string>;
  cancelled: Set<string>;
  accept: (promptId: string) => void;
  /** Optional side record. It must never interrupt accepted-job tracking or cancellation. */
  recordAccepted?: (promptId: string) => void;
  cancelRemote: (promptId: string) => Promise<boolean>;
  confirmCancellation: () => void;
  /** A false response or network error cannot prove cancellation. Reconcile the known ID. */
  resumeTracking: (promptId: string) => void;
}): Promise<string> {
  const promptId = await submit();
  accept(promptId);
  try {
    recordAccepted?.(promptId);
  } catch {
    // A browser ledger is supplementary; ComfyUI acceptance remains authoritative.
  }
  if (cancelled.delete(localId)) {
    let confirmed = false;
    try {
      confirmed = await cancelRemote(promptId);
    } catch {
      // Keep the accepted job observable and cancellable when the request cannot be confirmed.
    }
    if (confirmed) confirmCancellation();
    else resumeTracking(promptId);
  }
  return promptId;
}

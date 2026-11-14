import { useCallback, useEffect, useMemo, useState } from "react";
import type { Job } from "../jobs/types";
import type { Enhancer, Provider } from "../pipelines/registry";
import {
  acceptRun,
  addFingerprints,
  emptyRunLedger,
  observeJobs,
  sha256Json,
  type AcceptedRunInput,
  type RunLedger,
} from "./records";
import { loadRunLedger, updateRunLedger } from "./store";

type LedgerUpdate = (current: RunLedger) => RunLedger;

export function runLedgerStorageKey(scope: string): string {
  return `bashpacks.video-studio.run-ledger.v1:${scope}`;
}

function readLedger(key: string): { ledger: RunLedger; error: string | null } {
  try {
    return { ledger: loadRunLedger(localStorage, key), error: null };
  } catch {
    return { ledger: emptyRunLedger(), error: "Saved run records could not be read." };
  }
}

export function useRunLedger(scope: string) {
  const storageKey = useMemo(() => runLedgerStorageKey(scope), [scope]);
  const initial = useMemo(() => readLedger(storageKey), [storageKey]);
  const [ledger, setLedger] = useState(initial.ledger);
  const [error, setError] = useState<string | null>(initial.error);

  useEffect(() => {
    const next = readLedger(storageKey);
    setLedger(next.ledger);
    setError(next.error);
  }, [storageKey]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      const next = readLedger(storageKey);
      setLedger(next.ledger);
      setError(next.error);
    };
    addEventListener("storage", onStorage);
    return () => removeEventListener("storage", onStorage);
  }, [storageKey]);

  const commit = useCallback((update: LedgerUpdate) => {
    try {
      const next = updateRunLedger(localStorage, storageKey, update);
      setLedger(next);
      setError(null);
      return true;
    } catch {
      setError("Run records could not be saved in this browser.");
      return false;
    }
  }, [storageKey]);

  const recordAccepted = useCallback((promptId: string, input: AcceptedRunInput) => {
    if (!commit((current) => acceptRun(current, promptId, input))) return;
    void Promise.all([sha256Json(input.graph), sha256Json(input.manifest)])
      .then(([graph, manifest]) => commit((current) => addFingerprints(current, promptId, graph, manifest)))
      .catch(() => setError("Run fingerprints could not be saved in this browser."));
  }, [commit]);

  const observe = useCallback((jobs: Job[], providers: Provider[], enhancers: Enhancer[]) => {
    commit((current) => observeJobs(current, jobs, providers, enhancers));
  }, [commit]);

  return {
    ledger,
    error,
    recordAccepted,
    observe,
    recordFor: (job: Job) => job.promptId ? ledger.records[job.promptId] : undefined,
  };
}

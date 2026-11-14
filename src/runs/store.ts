import { parseRunLedger, type RunLedger } from "./records";

export type RunLedgerStorage = Pick<Storage, "getItem" | "setItem">;

export function loadRunLedger(storage: RunLedgerStorage, key: string): RunLedger {
  return parseRunLedger(storage.getItem(key));
}

/** Read, update and persist in that order so a failed write never appears saved in memory. */
export function updateRunLedger(storage: RunLedgerStorage, key: string, update: (current: RunLedger) => RunLedger): RunLedger {
  const current = loadRunLedger(storage, key);
  const next = update(current);
  if (next !== current) storage.setItem(key, JSON.stringify(next));
  return next;
}

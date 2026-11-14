/* Which part of a job is running, when one request takes several runs in a row (swap a thing: find the
   mask, then edit; replace: one pass per person). Every step of a request is queued under one idempotency
   key that shares its start, so the runs that exist say the place of each step. No database and no UI
   here, so the counting is testable on its own. */
export type JobPart = { part: number; parts: number };

/** The start of the idempotency key that every step of one request shares:
 *  `replace-<request>-<step>` from the Replace panel, `swap-<attempt>-<step>` from Swap a thing.
 *  A key of any other shape names one run, not a chain. */
export function chainKeyPrefix(key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  const replace = /^(replace-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-).+$/i.exec(key);
  if (replace) return replace[1];
  const swap = /^(swap-\d+-).+$/.exec(key);
  return swap ? swap[1] : undefined;
}

/** Where this run sits among the steps of its request. `keys` are the keys of every step queued so far,
 *  in the order they were queued, so a step that has not been queued yet is not counted: `parts` grows
 *  as the chain goes on. */
export function chainPart(keys: readonly string[], key: string | null | undefined): JobPart | undefined {
  if (!key) return undefined;
  const at = keys.indexOf(key);
  return at < 0 ? undefined : { part: at + 1, parts: keys.length };
}

/* Edit a reference in place: a reference slot opens its picture in FotoField, and the edited
   picture comes back into the same slot. One ticket per browser tab, kept in sessionStorage so it survives
   the screen change but never leaks into another tab.
   States: idle -> editing (ticket) -> applied (result) -> idle. "Back without changes" returns to idle. */

export type ReturnTicket = { slotKey: string; workspaceId: string; sourceAssetId: string; returnHash: string; createdAt: number };
type ReturnResult = { slotKey: string; assetId: string };

const TICKET = "cf-reference-return";
const RESULT = "cf-reference-return:result";
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const store = (): Store | undefined => { try { return sessionStorage; } catch { return undefined; } };
const read = <T>(s: Store | undefined, key: string): T | undefined => { try { const raw = s?.getItem(key); return raw ? JSON.parse(raw) as T : undefined; } catch { return undefined; } };

/** Edit pressed on a slot: remember where the edited picture goes. A new edit replaces an older ticket. */
export function beginReferenceEdit(ticket: Omit<ReturnTicket, "createdAt">, s: Store | undefined = store(), now = Date.now()): void {
  s?.setItem(TICKET, JSON.stringify({ ...ticket, createdAt: now }));
  s?.removeItem(RESULT);
}

/** The ticket for the picture open in FotoField, or undefined when FotoField was opened some other way. */
export function referenceEditFor(workspaceId: string, assetId: string | undefined, s: Store | undefined = store(), now = Date.now()): ReturnTicket | undefined {
  const ticket = read<ReturnTicket>(s, TICKET);
  if (!ticket || !assetId) return undefined;
  if (now - ticket.createdAt > MAX_AGE_MS) { s?.removeItem(TICKET); return undefined; }
  return ticket.workspaceId === workspaceId && ticket.sourceAssetId === assetId ? ticket : undefined;
}

/** "Use in tool": the edited picture waits for its slot; the ticket is spent. */
export function finishReferenceEdit(ticket: ReturnTicket, assetId: string, s: Store | undefined = store()): void {
  s?.setItem(RESULT, JSON.stringify({ slotKey: ticket.slotKey, assetId } satisfies ReturnResult));
  s?.removeItem(TICKET);
}

/** "Back without changes": the slot keeps what it had. */
export function cancelReferenceEdit(s: Store | undefined = store()): void { s?.removeItem(TICKET); }

/** A slot takes its edited picture once; any other slot gets nothing. */
export function takeEditedReference(slotKey: string, s: Store | undefined = store()): string | undefined {
  const result = read<ReturnResult>(s, RESULT);
  if (!result || result.slotKey !== slotKey) return undefined;
  s?.removeItem(RESULT);
  return result.assetId;
}

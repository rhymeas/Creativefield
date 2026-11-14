import { useCallback, useEffect, useRef, useState } from "react";
import type { ComfyClient } from "../comfy/client";
import { checkReadiness, OFFLINE, type Checkable, type Readiness } from "../workflow/readiness";

/**
 * Asks ComfyUI which providers it can run right now.
 * It re-checks when the connection comes back and whenever `refresh` is called
 * (the picker's Recheck button), so installing a model file does not need a page reload.
 */
export function useProviderStatus(client: ComfyClient, providers: Array<Checkable & { id: string }>, connected: boolean) {
  const [statuses, setStatuses] = useState<Record<string, Readiness>>({});
  const [checking, setChecking] = useState(false);
  const run = useRef(0); // ignores the result of a check that a newer one has replaced

  const refresh = useCallback(async () => {
    const mine = ++run.current;
    setChecking(true);
    let next: Record<string, Readiness>;
    try {
      const classes = providers.flatMap((p) => Object.values(p.template).map((n) => n.class_type));
      const info = await client.objectInfoFor(classes);
      next = Object.fromEntries(providers.map((p) => [p.id, checkReadiness(p, info)]));
    } catch {
      next = Object.fromEntries(providers.map((p) => [p.id, OFFLINE]));
    }
    if (mine === run.current) {
      setStatuses(next);
      setChecking(false);
    }
  }, [client, providers]);

  useEffect(() => {
    void refresh();
  }, [refresh, connected]);

  return { statuses, checking, refresh };
}

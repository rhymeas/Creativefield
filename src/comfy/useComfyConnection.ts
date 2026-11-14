import { useCallback, useEffect, useRef, useState } from "react";
import type { ComfyClient, ComfyEvent } from "./client";

/**
 * Owns the one WebSocket to ComfyUI. Other hooks listen through `subscribe`, so there is a
 * single socket however many parts of the studio care about live events.
 */
export function useComfyConnection(client: ComfyClient) {
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<(e: ComfyEvent) => void>());

  useEffect(
    () => client.connect((e) => listeners.current.forEach((listener) => listener(e)), setConnected),
    [client],
  );

  const subscribe = useCallback((listener: (e: ComfyEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  return { connected, subscribe };
}

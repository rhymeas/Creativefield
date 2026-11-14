import { useCallback, useEffect, useMemo, useState } from "react";
import {
  emptyLibraryMetadata,
  moveToTrash,
  parseLibraryMetadata,
  restoreFromTrash,
  setFavourite,
  type LibraryMetadata,
} from "./metadata";

type MetadataUpdate = (current: LibraryMetadata) => LibraryMetadata;

export function libraryMetadataStorageKey(scope: string): string {
  return `bashpacks.video-studio.library-meta.v1:${scope}`;
}

function readMetadata(key: string): { metadata: LibraryMetadata; error: string | null } {
  try {
    return { metadata: parseLibraryMetadata(localStorage.getItem(key)), error: null };
  } catch {
    return { metadata: emptyLibraryMetadata(), error: "Saved Library metadata could not be read." };
  }
}

export function useLibraryMetadata(scope: string) {
  const storageKey = useMemo(() => libraryMetadataStorageKey(scope), [scope]);
  const initial = useMemo(() => readMetadata(storageKey), [storageKey]);
  const [metadata, setMetadata] = useState(initial.metadata);
  const [error, setError] = useState<string | null>(initial.error);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      const next = readMetadata(storageKey);
      setMetadata(next.metadata);
      setError(next.error);
    };
    addEventListener("storage", onStorage);
    return () => removeEventListener("storage", onStorage);
  }, [storageKey]);

  const commit = useCallback((update: MetadataUpdate) => {
    try {
      const current = parseLibraryMetadata(localStorage.getItem(storageKey));
      const next = update(current);
      localStorage.setItem(storageKey, JSON.stringify(next));
      setMetadata(next);
      setError(null);
      return true;
    } catch {
      setError("Library changes could not be saved in this browser.");
      return false;
    }
  }, [storageKey]);

  return {
    metadata,
    error,
    setFavourite: (key: string, value: boolean) => commit((current) => setFavourite(current, key, value)),
    moveToTrash: (key: string) => commit((current) => moveToTrash(current, key)),
    restoreFromTrash: (key: string) => commit((current) => restoreFromTrash(current, key)),
  };
}

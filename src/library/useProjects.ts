import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createProject,
  deleteProject,
  emptyProjects,
  loadProjects,
  renameProject,
  setProjectMembership,
  updateProjects,
  type ProjectsState,
} from "./projects";

type ProjectUpdate = (current: ProjectsState) => ProjectsState;

export function projectsStorageKey(scope: string): string {
  return `bashpacks.video-studio.projects.v1:${scope}`;
}

function readProjects(key: string): { state: ProjectsState; error: string | null } {
  try {
    return { state: loadProjects(localStorage, key), error: null };
  } catch (error) {
    return { state: emptyProjects(), error: error instanceof Error ? error.message : "Saved projects could not be read." };
  }
}

export function useProjects(scope: string) {
  const storageKey = useMemo(() => projectsStorageKey(scope), [scope]);
  const initial = useMemo(() => readProjects(storageKey), [storageKey]);
  const [state, setState] = useState(initial.state);
  const [error, setError] = useState<string | null>(initial.error);

  useEffect(() => {
    const next = readProjects(storageKey);
    setState(next.state);
    setError(next.error);
  }, [storageKey]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      const next = readProjects(storageKey);
      setState(next.state);
      setError(next.error);
    };
    addEventListener("storage", onStorage);
    return () => removeEventListener("storage", onStorage);
  }, [storageKey]);

  const commit = useCallback((update: ProjectUpdate): ProjectsState | null => {
    try {
      const next = updateProjects(localStorage, storageKey, update);
      setState(next);
      setError(null);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Project changes could not be saved in this browser.");
      return null;
    }
  }, [storageKey]);

  return {
    state,
    error,
    create: (name: string, promptId?: string) => {
      const id = crypto.randomUUID();
      return commit((current) => {
        const created = createProject(current, id, name);
        return promptId ? setProjectMembership(created, id, promptId, true) : created;
      }) ? id : null;
    },
    rename: (id: string, name: string) => !!commit((current) => renameProject(current, id, name)),
    remove: (id: string) => !!commit((current) => deleteProject(current, id)),
    setMembership: (id: string, promptId: string, member: boolean) => !!commit((current) => setProjectMembership(current, id, promptId, member)),
  };
}

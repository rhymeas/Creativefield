export const PROJECTS_VERSION = 1 as const;

export type ProjectRecord = {
  name: string;
  createdAt: number;
  updatedAt: number;
  promptIds: string[];
};

export type ProjectsState = {
  version: typeof PROJECTS_VERSION;
  projects: Record<string, ProjectRecord>;
};

export type ProjectsStorage = Pick<Storage, "getItem" | "setItem">;

export const emptyProjects = (): ProjectsState => ({ version: PROJECTS_VERSION, projects: {} });

export function normalizeProjectName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 80) throw new Error("Project names must be between 1 and 80 characters.");
  return normalized;
}

function assertUniqueName(state: ProjectsState, name: string, exceptId?: string) {
  const normalized = name.toLocaleLowerCase();
  if (Object.entries(state.projects).some(([id, project]) => id !== exceptId && project.name.toLocaleLowerCase() === normalized)) {
    throw new Error("A project with that name already exists.");
  }
}

export function parseProjects(raw: string | null): ProjectsState {
  if (!raw) return emptyProjects();
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Projects data is invalid.");
  const candidate = value as { version?: unknown; projects?: unknown };
  if (candidate.version !== PROJECTS_VERSION || !candidate.projects || typeof candidate.projects !== "object" || Array.isArray(candidate.projects)) {
    throw new Error("Projects data has an unsupported or invalid shape.");
  }
  const projects: Record<string, ProjectRecord> = {};
  for (const [id, rawProject] of Object.entries(candidate.projects)) {
    if (!rawProject || typeof rawProject !== "object" || Array.isArray(rawProject)) throw new Error(`Project ${id} is invalid.`);
    const project = rawProject as Partial<ProjectRecord>;
    let normalizedName: string;
    try {
      normalizedName = typeof project.name === "string" ? normalizeProjectName(project.name) : "";
    } catch {
      throw new Error(`Project ${id} is invalid.`);
    }
    if (
      typeof project.name !== "string" || normalizedName !== project.name ||
      typeof project.createdAt !== "number" || !Number.isFinite(project.createdAt) ||
      typeof project.updatedAt !== "number" || !Number.isFinite(project.updatedAt) ||
      !Array.isArray(project.promptIds) || project.promptIds.some((promptId) => typeof promptId !== "string" || !promptId)
    ) throw new Error(`Project ${id} is invalid.`);
    projects[id] = { ...project as ProjectRecord, promptIds: [...new Set(project.promptIds)] };
  }
  const names = Object.values(projects).map((project) => project.name.toLocaleLowerCase());
  if (new Set(names).size !== names.length) throw new Error("Project names are duplicated.");
  return { version: PROJECTS_VERSION, projects };
}

export function createProject(state: ProjectsState, id: string, name: string, at = Date.now()): ProjectsState {
  const normalized = normalizeProjectName(name);
  if (!id || state.projects[id]) throw new Error("Project identity is invalid.");
  assertUniqueName(state, normalized);
  return {
    version: PROJECTS_VERSION,
    projects: { ...state.projects, [id]: { name: normalized, createdAt: at, updatedAt: at, promptIds: [] } },
  };
}

export function renameProject(state: ProjectsState, id: string, name: string, at = Date.now()): ProjectsState {
  const project = state.projects[id];
  if (!project) throw new Error("Project no longer exists.");
  const normalized = normalizeProjectName(name);
  assertUniqueName(state, normalized, id);
  return { version: PROJECTS_VERSION, projects: { ...state.projects, [id]: { ...project, name: normalized, updatedAt: at } } };
}

export function deleteProject(state: ProjectsState, id: string): ProjectsState {
  if (!state.projects[id]) return state;
  const projects = { ...state.projects };
  delete projects[id];
  return { version: PROJECTS_VERSION, projects };
}

export function setProjectMembership(state: ProjectsState, id: string, promptId: string, member: boolean, at = Date.now()): ProjectsState {
  const project = state.projects[id];
  if (!project) throw new Error("Project no longer exists.");
  if (!promptId) throw new Error("Only accepted ComfyUI jobs can be assigned to projects.");
  const promptIds = new Set(project.promptIds);
  if (member) promptIds.add(promptId);
  else promptIds.delete(promptId);
  return {
    version: PROJECTS_VERSION,
    projects: { ...state.projects, [id]: { ...project, promptIds: [...promptIds], updatedAt: at } },
  };
}

export function projectHasPrompt(state: ProjectsState, id: string, promptId: string): boolean {
  return state.projects[id]?.promptIds.includes(promptId) ?? false;
}

export function loadProjects(storage: ProjectsStorage, key: string): ProjectsState {
  return parseProjects(storage.getItem(key));
}

export function updateProjects(storage: ProjectsStorage, key: string, update: (current: ProjectsState) => ProjectsState): ProjectsState {
  const current = loadProjects(storage, key);
  const next = update(current);
  if (next !== current) storage.setItem(key, JSON.stringify(next));
  return next;
}

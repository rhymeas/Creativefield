import { describe, expect, it } from "vitest";
import type { Job } from "../src/jobs/types";
import { emptyLibraryMetadata, moveToTrash, restoreFromTrash } from "../src/library/metadata";
import {
  createProject,
  deleteProject,
  emptyProjects,
  loadProjects,
  parseProjects,
  renameProject,
  setProjectMembership,
  updateProjects,
  type ProjectsStorage,
} from "../src/library/projects";
import { loadedProjectCounts, selectProjectJobs } from "../src/library/selectors";
import { projectsStorageKey } from "../src/library/useProjects";

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  promptId: id,
  status: "done",
  progress: 100,
  queuePosition: null,
  providerId: "wan",
  model: "Wan",
  resolution: "480p",
  params: { prompt: `scene ${id}`, negative: "", startImage: "", aspect: "landscape", durationSec: 3, seed: 1 },
  thumb: null,
  createdAt: 1,
  ...over,
});

describe("browser-local projects", () => {
  it("normalizes names and rejects case-insensitive duplicates", () => {
    let state = createProject(emptyProjects(), "a", "  Client   A  ", 10);
    expect(state.projects.a.name).toBe("Client A");
    expect(() => createProject(state, "b", "client a", 20)).toThrow(/already exists/i);
    state = createProject(state, "b", "Client B", 20);
    expect(() => renameProject(state, "b", "CLIENT A", 30)).toThrow(/already exists/i);
  });

  it.each(["not json", JSON.stringify({ version: 2, projects: {} }), JSON.stringify({ version: 1, projects: [] })])(
    "rejects corrupt or unsupported storage: %s",
    (raw) => expect(() => parseProjects(raw)).toThrow(),
  );

  it("rejects an invalid child record instead of silently overwriting it later", () => {
    expect(() => parseProjects(JSON.stringify({ version: 1, projects: { bad: { name: "", createdAt: 1, updatedAt: 1, promptIds: [] } } }))).toThrow(/bad/);
  });

  it("deduplicates membership and keeps one job in several projects", () => {
    let state = createProject(emptyProjects(), "a", "A", 10);
    state = createProject(state, "b", "B", 20);
    state = setProjectMembership(state, "a", "prompt-1", true, 30);
    state = setProjectMembership(state, "a", "prompt-1", true, 40);
    state = setProjectMembership(state, "b", "prompt-1", true, 50);
    expect(state.projects.a.promptIds).toEqual(["prompt-1"]);
    expect(state.projects.b.promptIds).toEqual(["prompt-1"]);
  });

  it("preserves unloaded member IDs while counts describe loaded non-trashed jobs", () => {
    let state = createProject(emptyProjects(), "a", "A", 10);
    state = setProjectMembership(state, "a", "loaded", true, 20);
    state = setProjectMembership(state, "a", "older-unloaded", true, 30);
    expect(loadedProjectCounts([job("loaded")], emptyLibraryMetadata(), state)).toEqual({ a: 1 });
    expect(state.projects.a.promptIds).toEqual(["loaded", "older-unloaded"]);
  });

  it("filters by project and search, hides terminal Trash, and shows resumed active work", () => {
    let state = createProject(emptyProjects(), "a", "A", 10);
    state = setProjectMembership(state, "a", "one", true, 20);
    state = setProjectMembership(state, "a", "two", true, 30);
    const jobs = [job("one", { model: "Animate" }), job("two", { status: "cancelled" }), job("outside")];
    let metadata = moveToTrash(emptyLibraryMetadata(), "two", 40);
    expect(selectProjectJobs(jobs, metadata, state, "a", "animate").map((item) => item.promptId)).toEqual(["one"]);
    expect(selectProjectJobs(jobs, metadata, state, "a", "").map((item) => item.promptId)).toEqual(["one"]);
    const resumed = jobs.map((item) => item.promptId === "two" ? { ...item, status: "running" as const } : item);
    expect(selectProjectJobs(resumed, metadata, state, "a", "").map((item) => item.promptId)).toEqual(["one", "two"]);
    metadata = restoreFromTrash(metadata, "two");
    expect(selectProjectJobs(jobs, metadata, state, "a", "").map((item) => item.promptId)).toEqual(["one", "two"]);
  });

  it("rename and delete change only the collection record", () => {
    let state = createProject(emptyProjects(), "a", "A", 10);
    state = setProjectMembership(state, "a", "prompt-1", true, 20);
    const renamed = renameProject(state, "a", "Archive", 30);
    expect(renamed.projects.a.promptIds).toEqual(["prompt-1"]);
    expect(deleteProject(renamed, "a").projects).toEqual({});
  });

  it("does not report a storage-write failure as persisted", () => {
    let raw: string | null = null;
    const storage: ProjectsStorage = {
      getItem: () => raw,
      setItem: () => { throw new Error("quota"); },
    };
    expect(() => updateProjects(storage, "projects", (current) => createProject(current, "a", "A", 10))).toThrow("quota");
    expect(raw).toBeNull();
    expect(loadProjects(storage, "projects")).toEqual(emptyProjects());
  });

  it("scopes projects to the configured Comfy base string", () => {
    expect(projectsStorageKey("/comfy")).not.toBe(projectsStorageKey("http://other:8188"));
  });
});

import { isActive, type Job } from "../jobs/types";
import { libraryJobKey, type LibraryMetadata } from "./metadata";
import type { ProjectsState } from "./projects";

export type LibraryFilter = "all" | "generated" | "enhanced" | "favourites" | "active" | "failed" | "trash";
export type LibraryCounts = Record<LibraryFilter, number>;

const recordFor = (metadata: LibraryMetadata, job: Job) => {
  const key = libraryJobKey(job);
  return key ? metadata.records[key] : undefined;
};

export function isJobTrashed(metadata: LibraryMetadata, job: Job): boolean {
  // A server job can resume after a locally requested cancellation could not be
  // confirmed. Active work must stay visible and cancellable even if the user
  // moved its briefly-cancelled card to Trash during that reconciliation window.
  return !isActive(job.status) && recordFor(metadata, job)?.trashedAt !== undefined;
}

export function isJobFavourite(metadata: LibraryMetadata, job: Job): boolean {
  return recordFor(metadata, job)?.favourite === true;
}

export function libraryCounts(jobs: Job[], metadata: LibraryMetadata): LibraryCounts {
  const visible = jobs.filter((job) => !isJobTrashed(metadata, job));
  return {
    all: visible.length,
    generated: visible.filter((job) => job.kind !== "enhance").length,
    enhanced: visible.filter((job) => job.kind === "enhance").length,
    favourites: visible.filter((job) => isJobFavourite(metadata, job)).length,
    active: visible.filter((job) => isActive(job.status)).length,
    failed: visible.filter((job) => job.status === "failed").length,
    trash: jobs.filter((job) => isJobTrashed(metadata, job)).length,
  };
}

export function selectLibraryJobs(jobs: Job[], metadata: LibraryMetadata, filter: LibraryFilter, query: string): Job[] {
  const normalized = query.trim().toLocaleLowerCase();
  return jobs.filter((job) => {
    const trashed = isJobTrashed(metadata, job);
    const inCategory =
      filter === "trash"
        ? trashed
        : !trashed && (
            filter === "all" ||
            (filter === "generated" && job.kind !== "enhance") ||
            (filter === "enhanced" && job.kind === "enhance") ||
            (filter === "favourites" && isJobFavourite(metadata, job)) ||
            (filter === "active" && isActive(job.status)) ||
            (filter === "failed" && job.status === "failed")
          );
    if (!inCategory) return false;
    return matchesQuery(job, normalized);
  });
}

function matchesQuery(job: Job, normalized: string): boolean {
  if (!normalized) return true;
  return `${job.params.prompt} ${job.params.motionPrompt ?? ""} ${job.model} ${job.status}`.toLocaleLowerCase().includes(normalized);
}

export function selectProjectJobs(
  jobs: Job[],
  metadata: LibraryMetadata,
  projects: ProjectsState,
  projectId: string,
  query: string,
): Job[] {
  const members = new Set(projects.projects[projectId]?.promptIds ?? []);
  const normalized = query.trim().toLocaleLowerCase();
  return jobs.filter((job) => !!job.promptId && members.has(job.promptId) && !isJobTrashed(metadata, job) && matchesQuery(job, normalized));
}

export function loadedProjectCounts(jobs: Job[], metadata: LibraryMetadata, projects: ProjectsState): Record<string, number> {
  return Object.fromEntries(Object.entries(projects.projects).map(([id, project]) => {
    const members = new Set(project.promptIds);
    const count = jobs.filter((job) => !!job.promptId && members.has(job.promptId) && !isJobTrashed(metadata, job)).length;
    return [id, count];
  }));
}

export function selectEditorHistory(jobs: Job[], metadata: LibraryMetadata): Job[] {
  return jobs.filter((job) => !isJobTrashed(metadata, job));
}

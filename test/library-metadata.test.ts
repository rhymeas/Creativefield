import { describe, expect, it } from "vitest";
import type { Job } from "../src/jobs/types";
import {
  emptyLibraryMetadata,
  libraryJobKey,
  moveToTrash,
  parseLibraryMetadata,
  restoreFromTrash,
  setFavourite,
} from "../src/library/metadata";
import { libraryCounts, selectEditorHistory, selectLibraryJobs } from "../src/library/selectors";
import { libraryMetadataStorageKey } from "../src/library/useLibraryMetadata";

const job = (id: string, overrides: Partial<Job> = {}): Job => ({
  id: `local-${id}`,
  promptId: id,
  status: "done",
  progress: null,
  queuePosition: null,
  providerId: "provider",
  model: "Wan",
  resolution: "480p",
  params: { prompt: `prompt ${id}`, negative: "", startImage: "", aspect: "landscape", durationSec: 3, seed: 1 },
  thumb: null,
  createdAt: 1,
  ...overrides,
});

describe("Library metadata", () => {
  it("uses the accepted ComfyUI prompt ID instead of the session-local job ID", () => {
    expect(libraryJobKey(job("server-1"))).toBe("server-1");
    expect(libraryJobKey(job("pending", { promptId: undefined }))).toBeNull();
  });

  it("reads a versioned record and ignores invalid record fields", () => {
    const metadata = parseLibraryMetadata(JSON.stringify({
      version: 1,
      records: {
        valid: { favourite: true, trashedAt: 42 },
        invalid: { favourite: false, trashedAt: "yesterday" },
      },
    }));
    expect(metadata.records).toEqual({ valid: { favourite: true, trashedAt: 42 } });
  });

  it.each(["not json", JSON.stringify({ version: 2, records: {} }), JSON.stringify({ version: 1, records: [] })])(
    "rejects corrupt or unsupported storage: %s",
    (raw) => expect(() => parseLibraryMetadata(raw)).toThrow(),
  );

  it("retains a favourite through trash and restore", () => {
    let metadata = setFavourite(emptyLibraryMetadata(), "server-1", true);
    metadata = moveToTrash(metadata, "server-1", 50);
    expect(metadata.records["server-1"]).toEqual({ favourite: true, trashedAt: 50 });
    metadata = restoreFromTrash(metadata, "server-1");
    expect(metadata.records["server-1"]).toEqual({ favourite: true });
  });

  it("keeps trashed jobs out of ordinary categories and editor history", () => {
    const jobs = [job("generated"), job("enhanced", { kind: "enhance" }), job("active", { status: "running" })];
    let metadata = setFavourite(emptyLibraryMetadata(), "generated", true);
    metadata = moveToTrash(metadata, "enhanced", 50);

    expect(selectLibraryJobs(jobs, metadata, "all", "").map((item) => item.promptId)).toEqual(["generated", "active"]);
    expect(selectLibraryJobs(jobs, metadata, "favourites", "prompt").map((item) => item.promptId)).toEqual(["generated"]);
    expect(selectLibraryJobs(jobs, metadata, "trash", "").map((item) => item.promptId)).toEqual(["enhanced"]);
    expect(selectEditorHistory(jobs, metadata).map((item) => item.promptId)).toEqual(["generated", "active"]);
    expect(libraryCounts(jobs, metadata)).toEqual({ all: 2, generated: 2, enhanced: 0, favourites: 1, active: 1, failed: 0, trash: 1 });
  });

  it.each(["queued", "running"] as const)("makes a resumed %s job visible even when it was trashed while cancellation was unconfirmed", (status) => {
    const cancelled = job("server-1", { status: "cancelled" });
    const metadata = moveToTrash(emptyLibraryMetadata(), "server-1", 50);
    expect(selectLibraryJobs([cancelled], metadata, "trash", "")).toEqual([cancelled]);

    const resumed = { ...cancelled, status };
    expect(selectLibraryJobs([resumed], metadata, "trash", "")).toEqual([]);
    expect(selectLibraryJobs([resumed], metadata, "all", "")).toEqual([resumed]);
    expect(selectLibraryJobs([resumed], metadata, "active", "")).toEqual([resumed]);
    expect(selectEditorHistory([resumed], metadata)).toEqual([resumed]);
    expect(libraryCounts([resumed], metadata)).toMatchObject({ all: 1, active: 1, trash: 0 });
  });

  it("scopes browser metadata to the configured Comfy base string", () => {
    expect(libraryMetadataStorageKey("/comfy")).toContain(":/comfy");
    expect(libraryMetadataStorageKey("http://other:8188")).not.toBe(libraryMetadataStorageKey("/comfy"));
  });
});

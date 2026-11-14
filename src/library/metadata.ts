import type { Job } from "../jobs/types";

export const LIBRARY_METADATA_VERSION = 1 as const;

export type LibraryRecord = {
  favourite?: true;
  trashedAt?: number;
};

export type LibraryMetadata = {
  version: typeof LIBRARY_METADATA_VERSION;
  records: Record<string, LibraryRecord>;
};

export const emptyLibraryMetadata = (): LibraryMetadata => ({ version: LIBRARY_METADATA_VERSION, records: {} });

export function libraryJobKey(job: Job): string | null {
  return job.promptId || null;
}

export function parseLibraryMetadata(raw: string | null): LibraryMetadata {
  if (!raw) return emptyLibraryMetadata();
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("Library metadata is not an object");
  const candidate = value as { version?: unknown; records?: unknown };
  if (candidate.version !== LIBRARY_METADATA_VERSION) throw new Error("Library metadata has an unsupported version");
  if (!candidate.records || typeof candidate.records !== "object" || Array.isArray(candidate.records)) {
    throw new Error("Library metadata records are invalid");
  }

  const records: Record<string, LibraryRecord> = {};
  for (const [key, entry] of Object.entries(candidate.records)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as { favourite?: unknown; trashedAt?: unknown };
    const valid: LibraryRecord = {};
    if (record.favourite === true) valid.favourite = true;
    if (typeof record.trashedAt === "number" && Number.isFinite(record.trashedAt) && record.trashedAt > 0) valid.trashedAt = record.trashedAt;
    if (valid.favourite || valid.trashedAt) records[key] = valid;
  }
  return { version: LIBRARY_METADATA_VERSION, records };
}

function updateRecord(metadata: LibraryMetadata, key: string, update: (record: LibraryRecord) => LibraryRecord): LibraryMetadata {
  const records = { ...metadata.records };
  const next = update({ ...records[key] });
  if (next.favourite || next.trashedAt) records[key] = next;
  else delete records[key];
  return { version: LIBRARY_METADATA_VERSION, records };
}

export function setFavourite(metadata: LibraryMetadata, key: string, favourite: boolean): LibraryMetadata {
  return updateRecord(metadata, key, (record) => {
    if (favourite) record.favourite = true;
    else delete record.favourite;
    return record;
  });
}

export function moveToTrash(metadata: LibraryMetadata, key: string, at = Date.now()): LibraryMetadata {
  return updateRecord(metadata, key, (record) => ({ ...record, trashedAt: at }));
}

export function restoreFromTrash(metadata: LibraryMetadata, key: string): LibraryMetadata {
  return updateRecord(metadata, key, (record) => {
    delete record.trashedAt;
    return record;
  });
}

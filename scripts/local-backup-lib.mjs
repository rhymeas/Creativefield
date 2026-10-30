import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** Backup format written next to app.env, postgres/ and storage/. */
export const BACKUP_FORMAT_VERSION = 1;
/** Only the parts of a ComfyField home that make a complete, restorable copy. */
export const BACKUP_ENTRIES = ["app.env", "postgres", "storage"];
/** Default port of the local single-user server. */
export const DEFAULT_SERVER_PORT = 8787;
/** PostgreSQL writes these while it runs. They name the old data directory and port, so a
 * copy that carries them refuses to start in a new home. Never copied, never restored. */
const PG_RUNTIME_FILES = new Set(["postmaster.pid", "postmaster.opts", "launcher.log"]);
export function keepBackupFile(source) {
  const name = path.basename(source);
  return !(PG_RUNTIME_FILES.has(name) && path.basename(path.dirname(source)) === "postgres");
}

export function backupName(date = new Date()) {
  const stamp = date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  return `comfyfield-backup-${stamp}`;
}

export function manifestPath(directory) {
  return path.join(directory, "manifest.json");
}

export async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** True when the local app answers its health route. A running server means the database is in use. */
export async function isServerRunning({ port = DEFAULT_SERVER_PORT, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/v1/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function assertStopped({ isRunning = () => isServerRunning() } = {}) {
  if (await isRunning()) {
    throw new Error(
      `The app still answers on 127.0.0.1:${DEFAULT_SERVER_PORT}. Stop it first (Ctrl+C in its terminal) so the database closes cleanly.`,
    );
  }
}

/** Recursive byte and file count, used to verify a copy. */
export async function measure(target) {
  const info = await stat(target);
  if (info.isFile()) return { bytes: info.size, files: 1 };
  let bytes = 0;
  let files = 0;
  for (const name of await readdir(target)) {
    const child = await measure(path.join(target, name));
    bytes += child.bytes;
    files += child.files;
  }
  return { bytes, files };
}

export function sha256File(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function readManifest(directory) {
  const manifest = JSON.parse(await readFile(manifestPath(directory), "utf8"));
  if (manifest?.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(`Unsupported backup manifest version in ${directory}.`);
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error(`Backup manifest in ${directory} lists no entries.`);
  }
  for (const entry of manifest.entries) {
    if (!BACKUP_ENTRIES.includes(entry?.path) || !Number.isInteger(entry.files) || !Number.isInteger(entry.bytes)) {
      throw new Error(`Backup manifest in ${directory} has an invalid entry.`);
    }
  }
  return manifest;
}

/**
 * Cold, file-level backup of a ComfyField home. The embedded PostgreSQL build
 * ships no pg_dump, so the database directory is copied while the app is stopped.
 */
export async function createBackup({
  home,
  outDir,
  now = new Date(),
  appVersion = "unknown",
  isRunning = () => isServerRunning(),
}) {
  await assertStopped({ isRunning });
  if (!(await pathExists(path.join(home, "app.env")))) {
    throw new Error(`${home} does not look like a ComfyField home: app.env is missing.`);
  }
  await mkdir(outDir, { recursive: true });
  const directory = path.join(outDir, backupName(now));
  await mkdir(directory);
  const entries = [];
  for (const name of BACKUP_ENTRIES) {
    const from = path.join(home, name);
    if (!(await pathExists(from))) continue;
    await cp(from, path.join(directory, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      filter: keepBackupFile,
    });
    entries.push({ path: name, ...(await measure(path.join(directory, name))) });
  }
  if (!entries.some((entry) => entry.path === "app.env")) {
    throw new Error("app.env could not be copied; the backup is incomplete.");
  }
  const manifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: now.toISOString(),
    appVersion,
    sourceServerPort: DEFAULT_SERVER_PORT,
    entries,
  };
  await writeFile(manifestPath(directory), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const entry of entries) {
    const copied = await measure(path.join(directory, entry.path));
    if (copied.bytes !== entry.bytes || copied.files !== entry.files) {
      throw new Error(`Backup verification failed for ${entry.path}.`);
    }
  }
  return { directory, manifest };
}

/**
 * Restores a verified backup into a home directory. Refuses a non-empty target
 * unless force is set, and never touches a running app.
 */
export async function restoreBackup({
  backupDir,
  home,
  force = false,
  isRunning = () => isServerRunning(),
}) {
  await assertStopped({ isRunning });
  const manifest = await readManifest(backupDir);
  for (const entry of manifest.entries) {
    const source = path.join(backupDir, entry.path);
    if (!(await pathExists(source))) throw new Error(`Backup is missing ${entry.path}.`);
    const copied = await measure(source);
    if (copied.bytes !== entry.bytes || copied.files !== entry.files) {
      throw new Error(`Backup ${entry.path} does not match its manifest.`);
    }
  }
  if ((await pathExists(home)) && !force) {
    const names = await readdir(home);
    if (names.length > 0) {
      throw new Error(`Restore target ${home} is not empty. Move it aside or pass --force.`);
    }
  }
  await mkdir(home, { recursive: true });
  for (const entry of manifest.entries) {
    const to = path.join(home, entry.path);
    if (await pathExists(to)) await rm(to, { recursive: true, force: true });
    await cp(path.join(backupDir, entry.path), to, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      filter: keepBackupFile,
    });
  }
  return { home, manifest };
}

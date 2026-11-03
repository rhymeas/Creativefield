import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
// @ts-expect-error plain-JS backup helpers ship with the downloadable package
import { backupName, createBackup, measure, readManifest, restoreBackup } from "../scripts/local-backup-lib.mjs";

const now = new Date("2026-10-18T12:34:56.789Z");

describe("local cold backup and restore", () => {
  let root: string;
  let home: string;
  let outDir: string;

  beforeAll(async () => {
    root = await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-backup-");
    home = path.join(root, "home");
    outDir = path.join(root, "backups");
    await mkdir(path.join(home, "postgres", "base"), { recursive: true });
    await mkdir(path.join(home, "storage"), { recursive: true });
    await writeFile(path.join(home, "app.env"), "MASTER_KEY=secret\n");
    await writeFile(path.join(home, "postgres", "base", "1"), "database");
    await writeFile(path.join(home, "storage", "clip.mp4"), "video");
  }, 15000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("names backups by UTC timestamp", () => {
    expect(backupName(now)).toBe("comfyfield-backup-2026-10-18T12-34-56Z");
  });

  it("refuses while the app still answers", async () => {
    await expect(
      createBackup({ home, outDir, now, isRunning: async () => true }),
    ).rejects.toThrow("Stop it first");
  });

  it("copies, manifests and verifies the complete home", async () => {
    const { directory, manifest } = await createBackup({
      home,
      outDir,
      now,
      appVersion: "0.1.0",
      isRunning: async () => false,
    });
    expect(path.basename(directory)).toBe("comfyfield-backup-2026-10-18T12-34-56Z");
    expect(manifest).toMatchObject({ formatVersion: 1, appVersion: "0.1.0" });
    expect(manifest.entries.map((entry: { path: string }) => entry.path)).toEqual([
      "app.env",
      "postgres",
      "storage",
    ]);
    expect(await readManifest(directory)).toEqual(manifest);
    expect(await readFile(path.join(directory, "app.env"), "utf8")).toBe("MASTER_KEY=secret\n");
    expect(await measure(path.join(directory, "storage"))).toEqual({ bytes: 5, files: 1 });
  }, 15000);

  it("restores into an empty home and refuses a non-empty one without force", async () => {
    const backupDir = path.join(outDir, backupName(now));
    const restoredHome = path.join(root, "restored");
    await restoreBackup({ backupDir, home: restoredHome, isRunning: async () => false });
    expect(await readFile(path.join(restoredHome, "storage", "clip.mp4"), "utf8")).toBe("video");

    await expect(
      restoreBackup({ backupDir, home: restoredHome, isRunning: async () => false }),
    ).rejects.toThrow("not empty");
    await restoreBackup({ backupDir, home: restoredHome, force: true, isRunning: async () => false });
    expect(await readFile(path.join(restoredHome, "app.env"), "utf8")).toBe("MASTER_KEY=secret\n");
  }, 15000);

  it("rejects a tampered manifest before copying", async () => {
    const directory = path.join(root, "tampered");
    await mkdir(directory);
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        formatVersion: 1,
        createdAt: now.toISOString(),
        appVersion: "0.1.0",
        entries: [{ path: "../outside", bytes: 1, files: 1 }],
      }),
    );
    await expect(readManifest(directory)).rejects.toThrow("invalid entry");
  });
});

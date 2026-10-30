#!/usr/bin/env node
/**
 * Cold backup and restore for the local single-user app.
 *
 *   node scripts/backup-local.mjs                 backup into ./backups
 *   node scripts/backup-local.mjs --out /path/to/backups backup somewhere else
 *   node scripts/backup-local.mjs restore <dir>   restore a backup into the home
 *
 * Stop the app first. The embedded PostgreSQL build has no pg_dump, so this is
 * a file-level copy of app.env, postgres/ and storage/ while nothing runs.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_PORT, resolveHomeDir } from "./local-setup-lib.mjs";
import { createBackup, restoreBackup } from "./local-backup-lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = resolveHomeDir(projectRoot);
const args = process.argv.slice(2);
const command = args[0] === "restore" ? "restore" : "backup";
const rest = command === "restore" ? args.slice(1) : args;

let outDir = path.join(projectRoot, "backups");
let force = false;
const positional = [];
for (let index = 0; index < rest.length; index++) {
  const arg = rest[index];
  if (arg === "--out") outDir = path.resolve(rest[++index] ?? "");
  else if (arg === "--force") force = true;
  else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
  else positional.push(arg);
}

/* A person running this wants the sentence, not a stack trace: "Stop it first (Ctrl+C in its
   terminal)" is the whole answer. Set COMFYFIELD_DEBUG=1 when the stack is what you need. */
async function main() {
if (command === "backup") {
  if (positional.length) throw new Error("Backup takes no positional arguments. Use --out <dir>.");
  const appVersion = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")).version;
  const { directory, manifest } = await createBackup({ home, outDir, appVersion });
  const files = manifest.entries.reduce((sum, entry) => sum + entry.files, 0);
  const bytes = manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0);
  console.log(`Backup written to ${directory}`);
  console.log(`  ${files} files, ${bytes} bytes, app ${manifest.appVersion}`);
  console.log("  It contains app.env (database password and master key). Store it protected.");
} else {
  const backupDir = path.resolve(positional[0] ?? "");
  if (!positional[0]) throw new Error("Restore needs the backup directory: restore <dir>.");
  const { manifest } = await restoreBackup({ backupDir, home, force });
  console.log(`Restored ${manifest.entries.length} entries from ${backupDir} into ${home}`);
  console.log(`  Backup created ${manifest.createdAt} (app ${manifest.appVersion}, port ${SERVER_PORT}).`);
  console.log("  Start the app with npm start.");
}

}

try {
  await main();
} catch (error) {
  console.error(error?.message ?? String(error));
  if (process.env.COMFYFIELD_DEBUG) console.error(error?.stack ?? "");
  process.exit(1);
}

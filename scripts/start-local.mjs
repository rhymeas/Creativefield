// One-command start for the downloadable package.
//
//   npm start        (runs node scripts/start-local.mjs)
//
// Runs setup first if needed, starts the embedded PostgreSQL, starts the
// app server against .comfyfield/app.env, waits for /api/v1/health and
// opens the browser. Ctrl+C stops server and database cleanly.

import {createPersistentPostgres} from "./postgres-lifecycle.mjs";
import { existsSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireSupportedNode, SERVER_PORT, parseEnvContent, pgPort, resolveHomeDir } from "./local-setup-lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const homeDir = resolveHomeDir(projectRoot);
const pgDataDir = path.join(homeDir, "postgres");
const envPath = path.join(homeDir, "app.env");
const url = `http://127.0.0.1:${SERVER_PORT}/#video`;

function run(command, args) {
  // shell is only needed to resolve npm.cmd on Windows; executable paths
  // (which may contain spaces, e.g. the Node.js install folder) must not
  // go through a shell unquoted.
  const needsShell = process.platform === "win32" && !command.endsWith(".exe");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit", shell: needsShell });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

// Signal 0 only asks whether a process exists; it sends nothing.
export function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

// A crash or a console close event can leave postmaster.pid behind. Starting
// on that stale file ends in ECONNREFUSED, so move it aside once its process
// is gone. Returns the new path, or null when there was nothing stale.
export async function clearStalePostmaster(directory, io = {}) {
  const read = io.read ?? readFile, move = io.move ?? rename, running = io.running ?? processIsRunning;
  const file = path.join(directory, "postmaster.pid");
  let text;
  try { text = await read(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const pid = Number(String(text).trim().split(/\r?\n/)[0]);
  if (running(pid)) return null;
  const aside = `${file}.stale-${Date.now()}-${process.pid}`;
  await move(file, aside);
  console.log(`[start] Moved a stale postmaster.pid aside; process ${Number.isInteger(pid) && pid > 0 ? pid : "unknown"} is not running.`);
  return aside;
}

async function main() {
  requireSupportedNode();

  if (!existsSync(envPath) || !existsSync(path.join(pgDataDir, "PG_VERSION"))) {
    console.log("[start] First run: running automated setup...");
    await run(process.execPath, [path.join(projectRoot, "scripts", "setup-local.mjs")]);
  }

  const envValues = parseEnvContent(await readFile(envPath, "utf8"));
  const dbMatch = /postgres:\/\/postgres:([^@]+)@/.exec(envValues.DATABASE_URL ?? "");
  if (!dbMatch) throw new Error(`Cannot read the database password from ${envPath}. Restore the matching app.env from a complete backup; keep the existing database and storage intact.`);
  await clearStalePostmaster(pgDataDir);
  // The launcher runs pg_ctl detached in its own process group, so a console
  // Ctrl+C meant for another program never reaches the postmaster.
  const pg = await createPersistentPostgres({
    databaseDir: pgDataDir,
    user: "postgres",
    password: decodeURIComponent(dbMatch[1]),
    port: pgPort(),
    persistent: true,
  });
  await pg.start();
  console.log("[start] Local PostgreSQL running.");

  const server = spawn(process.execPath, ["--env-file", envPath, "--import", "tsx", "server/main.ts"], {
    cwd: projectRoot,
    stdio: "inherit",
  });

  let stopping = false;
  let databaseRestarts = 0;
  let checkingDatabase = false;
  // A dead database would otherwise leave the server answering nothing until
  // the next start. Restarting it once keeps the session open.
  async function keepDatabaseRunning() {
    if (stopping || checkingDatabase || databaseRestarts >= 1) return;
    checkingDatabase = true;
    try {
      let pid;
      try { pid = Number((await readFile(path.join(pgDataDir, "postmaster.pid"), "utf8")).trim().split(/\r?\n/)[0]); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (pid !== undefined && processIsRunning(pid)) return;
      databaseRestarts += 1;
      console.error("[start] Local PostgreSQL stopped while the server was running. Restarting it once.");
      await clearStalePostmaster(pgDataDir);
      await pg.stop();
      await pg.start();
      console.log("[start] Local PostgreSQL is running again.");
    } catch (error) {
      console.error("[start] Local PostgreSQL could not be restarted:", error.message);
    } finally {
      checkingDatabase = false;
    }
  }
  const databaseMonitor = setInterval(() => void keepDatabaseRunning(), 3000);

  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    clearInterval(databaseMonitor);
    server.kill();
    try { await pg.stop(); } catch (error) { console.error("[start] Database shutdown needs attention:",error.message); code=1; }
    process.exit(code);
  }
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  server.on("close", (code) => void shutdown(code ?? 0));

  async function waitForHealth() {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/v1/health`);
        if (response.ok) return true;
      } catch { /* server not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  }

  if (await waitForHealth()) {
    console.log(`[start] ComfyField is ready at ${url}`);
    if (!process.env.COMFYFIELD_NO_BROWSER) {
      const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin" ? ["open", [url]]
        : ["xdg-open", [url]];
      spawn(opener[0], opener[1], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
    }
  } else {
    console.error("[start] Server did not become healthy within 60 seconds.");
    await shutdown(1);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();

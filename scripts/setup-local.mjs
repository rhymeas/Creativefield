// Fully automated first-run setup for the downloadable package.
//
//   node scripts/setup-local.mjs
//
// Steps (all idempotent, no admin rights, nothing overwritten):
//   1. Install dependencies if node_modules is missing.
//   2. Download + initialise an embedded PostgreSQL in COMFYFIELD_HOME
//      (default: <project>/.comfyfield) and create the app database.
//   3. Write app.env with generated secrets if it does not exist yet.
//   4. Build the UI (npm run build) if dist/ is missing.
//
// The app server itself runs migrations and creates the local single
// user on first start (server/main.ts), so setup ends after the build.

import {createPersistentPostgres} from "./postgres-lifecycle.mjs";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  requireSupportedNode,
  PG_DATABASE,
  buildDatabaseUrl,
  buildEnvContent,
  generateMasterKey,
  generateSecret,
  missingEnvKeys,
  pgPort,
  resolveHomeDir,
} from "./local-setup-lib.mjs";

requireSupportedNode();

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const homeDir = resolveHomeDir(projectRoot);
const pgDataDir = path.join(homeDir, "postgres");
const storageRoot = path.join(homeDir, "storage");
const envPath = path.join(homeDir, "app.env");
const port = pgPort();

function run(command, args) {
  // shell is only needed to resolve npm.cmd on Windows; executable paths
  // (which may contain spaces, e.g. the Node.js install folder) must not
  // go through a shell unquoted.
  const needsShell = process.platform === "win32" && !command.endsWith(".exe");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit", shell: needsShell });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`))));
  });
}

async function ensureDependencies() {
  if (existsSync(path.join(projectRoot, "node_modules", "embedded-postgres"))) return;
  console.log("[setup] Installing dependencies (first run only)...");
  await run("npm", ["ci"]);
}

async function ensurePostgres() {
  // The database password is generated once and only stored inside app.env.
  let password;
  if (existsSync(envPath)) {
    const existing = await readFile(envPath, "utf8");
    const match = /postgres:\/\/postgres:([^@]+)@/.exec(existing);
    if (match) password = decodeURIComponent(match[1]);
  }
  const clusterExists = existsSync(path.join(pgDataDir, "PG_VERSION"));
  if (clusterExists && !password) {
    // Do not replace unknown credentials or keys for an existing cluster.
    throw new Error(
      `Found an existing database in ${pgDataDir} but no database password in ${envPath}. ` +
      `Preserve ${homeDir} and restore the matching app.env from a complete backup. ` +
      "Setup will not create replacement credentials for this existing cluster.",
    );
  }
  password ??= generateSecret(18);
  // Keep matching credentials durable even if first initialization is interrupted.
  await ensureEnvFile(password);

  const pg = await createPersistentPostgres({
    databaseDir: pgDataDir,
    user: "postgres",
    password,
    port,
    persistent: true,
    // The server refuses non-UTF8 databases (server/db.ts), while initdb
    // would otherwise pick the OS locale encoding (e.g. WIN1252 on Windows).
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });
  if (!clusterExists) {
    console.log("[setup] Downloading and initialising local PostgreSQL (first run only)...");
    await pg.initialise();
  }
  await pg.start();
  try {
    try {
      await pg.createDatabase(PG_DATABASE);
    } catch (error) {
      // Only "already exists" is expected on later runs; anything else
      // (e.g. password mismatch) must abort setup instead of failing later.
      if (!/already exists/i.test(String(error?.message ?? error))) throw error;
    }
    // Verify the encoding the way the server will, so an old cluster created
    // without UTF8 fails here with a clear remedy instead of at app start.
    const { Client } = await import("pg");
    const client = new Client({ connectionString: buildDatabaseUrl(password, port) });
    await client.connect();
    try {
      const { rows } = await client.query("SHOW server_encoding");
      if (rows[0]?.server_encoding !== "UTF8") {
        throw new Error(
          `The existing database in ${pgDataDir} is not UTF8 (server_encoding=${rows[0]?.server_encoding}). ` +
          `Preserve ${homeDir}, take a complete backup and migrate the data to a UTF8 cluster before continuing.`,
        );
      }
    } finally {
      await client.end();
    }
    console.log(`[setup] PostgreSQL ready on 127.0.0.1:${port}, database "${PG_DATABASE}".`);
  } finally {
    await pg.stop();
  }
  return password;
}

async function ensureEnvFile(password) {
  if (existsSync(envPath)) {
    const existing = await readFile(envPath, "utf8");
    const missing = missingEnvKeys(existing);
    if (missing.length) throw new Error(`${envPath} exists but is missing: ${missing.join(", ")}. Restore the matching configuration from a complete backup; do not delete the existing data.`);
    console.log("[setup] Existing app.env kept (secrets preserved).");
    await chmod(envPath, 0o600).catch(() => {});
    return;
  }
  const content = buildEnvContent({
    databaseUrl: buildDatabaseUrl(password, port),
    storageRoot,
    masterKey: generateMasterKey(),
  });
  await writeFile(envPath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(envPath, 0o600).catch(() => {});
  console.log(`[setup] Wrote ${envPath} with generated secrets.`);
}

async function ensureBuild() {
  if (existsSync(path.join(projectRoot, "dist", "index.html"))) return;
  console.log("[setup] Building the UI (first run only)...");
  await run("npm", ["run", "build"]);
}

await mkdir(homeDir, { recursive: true, mode: 0o700 });
await chmod(homeDir, 0o700).catch(() => {});
await mkdir(storageRoot, { recursive: true });
await ensureDependencies();
await ensurePostgres();
await ensureBuild();
console.log("[setup] Done. Start the app with: npm start");

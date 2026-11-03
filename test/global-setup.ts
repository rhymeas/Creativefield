import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Starts one throwaway PostgreSQL cluster (embedded binaries, no admin
// rights) for the whole test run and exposes it as TEST_DATABASE_URL, so
// the database-backed integration suites run instead of skipping. Each
// suite already isolates itself in a UUID-named schema it creates/drops.
// An externally provided TEST_DATABASE_URL always wins.
export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (process.env.TEST_DATABASE_URL) return;
  const dataDir = await mkdtemp(join(tmpdir(), "comfyfield-test-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const password = "comfyfield-test";
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password,
    port,
    persistent: false,
    // server/db.ts refuses non-UTF8 databases; initdb would otherwise pick
    // the OS locale encoding (e.g. WIN1252 on Windows).
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("comfyfield_test");
  process.env.TEST_DATABASE_URL =
    `postgresql://postgres:${password}@127.0.0.1:${port}/comfyfield_test`;
  return async () => {
    await pg.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  };
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { database, guardPool, migrate, queryWithRetry } from "../server/db";
import { buildServer } from "../server/app";
// @ts-expect-error plain-JS start helper ships with the downloadable package
import { clearStalePostmaster, processIsRunning } from "../scripts/start-local.mjs";

const connectionString = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:5173";

// A dropped backend must cost one log line, not the whole team server. The
// suite uses its own schema and its own application_name on the throwaway
// test cluster, so it never touches another suite's connections.
describe.skipIf(!connectionString)("a database connection that drops mid-run", () => {
  const schema = `cf_db_resilience_${randomUUID().replaceAll("-", "")}`;
  const applicationName = `cf_db_resilience_${randomUUID()}`;
  let root: Pool, pool: Pool, server: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    root = new Pool({ connectionString });
    await root.query(`CREATE SCHEMA ${schema}`);
    pool = guardPool(new Pool({ connectionString, application_name: applicationName, options: `-c search_path=${schema}` }));
    await migrate(pool);
    server = await buildServer({
      databaseUrl: connectionString!,
      storageRoot: await mkdtemp(join(tmpdir(), "db-resilience-")),
      masterKey: randomBytes(32),
      publicOrigin: origin,
      host: "127.0.0.1",
      port: 8787,
      sessionTtlHours: 1,
      inviteTtlHours: 1,
      maxUploadBytes: 1024 * 1024,
      cookieSecure: false,
    }, pool, { catalogue: [] });
    await server.app.ready();
  });
  afterAll(async () => {
    await server?.app.close().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    if (root) { await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await root.end().catch(() => undefined); }
  });

  it("guards the pool the server runs on", () => {
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    const sample = database(connectionString!);
    expect(sample.listenerCount("error")).toBe(1);
    return sample.end();
  });

  it("answers /health and runs the next query after its backends are terminated", async () => {
    const before = await server.app.inject({ method: "GET", url: "/api/v1/health" });
    expect(before.statusCode, before.body).toBe(200);
    // Two clients so at least one is idle when it is terminated.
    await Promise.all([pool.query("SELECT 1"), pool.query("SELECT 1")]);
    const dropped = new Promise<Error>(resolve => pool.once("error", error => resolve(error)));
    const killed = await root.query(
      "SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()",
      [applicationName],
    );
    expect(killed.rowCount).toBeGreaterThan(0);
    // Resolves only because the pool handled the idle-client error instead of
    // letting it end the process.
    await dropped;
    const after = await server.app.inject({ method: "GET", url: "/api/v1/health" });
    expect(after.statusCode, after.body).toBe(200);
    expect((await pool.query("SELECT 1 AS ok")).rows[0].ok).toBe(1);
  });
});

describe("a pool that cannot report errors", () => {
  const bare = (query: Pool["query"]) => ({ query }) as unknown as Pool;

  it("is guarded without an error listener", () => {
    const pool = bare(async () => ({ rows: [], rowCount: 0 }) as never);
    expect(guardPool(pool)).toBe(pool);
  });

  it("retries once when the first query meets a terminated backend", async () => {
    const answers: unknown[] = [Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }), { rows: [{ ok: 1 }], rowCount: 1 }];
    let calls = 0;
    const pool = bare((async () => { const answer = answers[calls++]; if (answer instanceof Error) throw answer; return answer; }) as Pool["query"]);
    expect((await queryWithRetry(pool, "SELECT 1")).rows[0]).toEqual({ ok: 1 });
    expect(calls).toBe(2);
  });

  it("does not retry any other error", async () => {
    let calls = 0;
    const pool = bare((async () => { calls++; throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); }) as Pool["query"]);
    await expect(queryWithRetry(pool, "SELECT 1")).rejects.toThrow("relation does not exist");
    expect(calls).toBe(1);
  });
});

describe("start-local does not start on a stale postmaster.pid", () => {
  it("moves a stale file aside once its process is gone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cf-stale-pg-"));
    const file = join(directory, "postmaster.pid");
    await writeFile(file, `999999\n${directory}\n1792600000\n55433\n`);
    try {
      const aside = await clearStalePostmaster(directory, { running: () => false });
      expect(aside).toMatch(/postmaster\.pid\.stale-/);
      expect(existsSync(file)).toBe(false);
      expect(existsSync(aside)).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps a live postmaster and finds nothing to move when the file is gone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cf-stale-pg-"));
    const file = join(directory, "postmaster.pid");
    await writeFile(file, `1234\n${directory}\n1792600000\n55433\n`);
    try {
      expect(await clearStalePostmaster(directory, { running: () => true })).toBeNull();
      expect(existsSync(file)).toBe(true);
      await rm(file);
      expect(await clearStalePostmaster(directory, { running: () => true })).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("checks a real process without sending a signal", () => {
    expect(processIsRunning(process.pid)).toBe(true);
    expect(processIsRunning(-1)).toBe(false);
    expect(processIsRunning(0)).toBe(false);
    expect(processIsRunning(Number.NaN)).toBe(false);
  });
});

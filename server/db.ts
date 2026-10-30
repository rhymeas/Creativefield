import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { readFile, readdir } from "node:fs/promises";

const guarded = new WeakSet<Pool>();

/* An idle client that loses its connection emits "error" on the pool. Without a listener that
   error is unhandled and ends the whole process, so every pool says one line and keeps running;
   pg-pool discards the broken client and the next query opens a fresh one. A stand-in pool
   without an "error" event (tests hand the server a bare {query}) is left as it is. */
export function guardPool(pool: Pool): Pool {
  if (!guarded.has(pool) && typeof pool.on === "function") {
    guarded.add(pool);
    pool.on("error", error => console.error(`[db] A database connection dropped; the next query reconnects: ${error.message}`));
  }
  return pool;
}

/* A backend that was just terminated fails the query already in flight, because pg-pool hands
   that client out before it knows it is dead. The client is gone after that, so one retry lands
   on a fresh one and the caller never sees the drop. */
const droppedCodes = new Set(["57P01", "57P02", "57P03", "08003", "08006", "ECONNRESET", "ECONNREFUSED", "EPIPE"]);
export function isDroppedConnection(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code === "string" && droppedCodes.has(code)) return true;
  return typeof message === "string" && /connection (error|terminated)|terminating connection/i.test(message);
}
export async function queryWithRetry<T extends QueryResultRow = QueryResultRow>(pool: Pool, text: string, values?: unknown[]): Promise<QueryResult<T>> {
  try { return await pool.query<T>(text, values); }
  catch (error) {
    if (!isDroppedConnection(error)) throw error;
    return await pool.query<T>(text, values);
  }
}
export function database(connectionString: string): Pool {
  return guardPool(new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 30000 }));
}
export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value; }
  catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}
export async function migrate(pool: Pool): Promise<void> {
  const encoding=(await pool.query("SHOW server_encoding")).rows[0]?.server_encoding;
  if(encoding!=="UTF8")throw new Error("ComfyField requires a UTF8 PostgreSQL database; create one from template0 with ENCODING 'UTF8'");
  await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(78146720)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const dir = new URL("./migrations/", import.meta.url);
    for (const name of (await readdir(dir)).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
      if ((await client.query("SELECT name FROM schema_migrations WHERE name=$1", [name])).rowCount) continue;
      await client.query(await readFile(new URL(name, dir), "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
    }
  });
}

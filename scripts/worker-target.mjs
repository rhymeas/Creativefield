// Points the local worker at the fixture worker or back at the real ComfyUI.
// Usage: node --env-file=.comfyfield/app.env scripts/worker-target.mjs fixture|local [--force]
import pg from "pg";

const REAL = process.env.FIXTURE_REAL_COMFY ?? "http://127.0.0.1:8188";
const FIXTURE = `http://127.0.0.1:${process.env.FIXTURE_PORT ?? 8191}`;
const [target, flag] = process.argv.slice(2);
if (!["fixture", "local"].includes(target)) { console.error("Usage: worker-target.mjs fixture|local [--force]"); process.exit(1); }
const [from, to] = target === "fixture" ? [REAL, FIXTURE] : [FIXTURE, REAL];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  // Unfinished runs would be answered by the other side (real runs as placeholders, or the reverse), so stop unless forced.
  const open = (await pool.query("SELECT count(*)::int AS n FROM runs r JOIN workers w ON w.id=r.worker_id AND w.workspace_id=r.workspace_id WHERE w.origin=$1 AND r.state IN ('pending','submitting','submission_unknown','queued','running','cancel_requested')", [from])).rows[0].n;
  if (open && flag !== "--force") { console.error(`${open} unfinished run(s) on ${from}. Let them finish or cancel them, or pass --force.`); process.exit(2); }
  // Clearing the inventory makes the app probe the new origin before it trusts readiness again.
  // The name says which side is behind the worker, so placeholder output is never mistaken for a model run.
  const moved = await pool.query("UPDATE workers SET origin=$2,checked_at=NULL,inventory=NULL,name=regexp_replace(name,' \\(fixtures\\)$','')||CASE WHEN $3 THEN ' (fixtures)' ELSE '' END WHERE origin=$1 RETURNING name", [from, to, target === "fixture"]);
  console.log(moved.rowCount ? `${moved.rows.map((r) => r.name).join(", ")} now use ${to}` : `No worker uses ${from}; nothing changed.`);
  if (target === "fixture") console.log("Start the fixture worker with: npm run fixture-worker");
} finally { await pool.end(); }

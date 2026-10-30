// Repoint the enabled worker at any HTTP(S) ComfyUI origin, e.g. a rented GPU.
// Usage: node --env-file=.comfyfield/app.env scripts/worker-point.mjs <origin> [apiPrefix]
import pg from "pg";

const [rawOrigin, apiPrefix = "/api"] = process.argv.slice(2);
if (!rawOrigin) { console.error("Usage: worker-point.mjs <origin> [apiPrefix]"); process.exit(1); }
const url = new URL(rawOrigin);
if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
  console.error("Worker origin must be a plain http(s) origin, e.g. https://mypod-8188.proxy.runpod.net");
  process.exit(1);
}
if (!["", "/api"].includes(apiPrefix)) { console.error("apiPrefix must be \"\" or \"/api\""); process.exit(1); }

const pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
try {
  const before = (await pool.query("SELECT id,name,origin FROM workers WHERE enabled=true")).rows;
  if (!before.length) { console.error("No enabled worker to repoint; add one in the app first."); process.exit(1); }
  // Clearing the inventory makes the app probe the new origin before trusting readiness again.
  const moved = await pool.query(
    "UPDATE workers SET origin=$1,api_prefix=$2,checked_at=NULL,inventory=NULL WHERE enabled=true RETURNING id,name",
    [url.origin, apiPrefix],
  );
  const rows = moved.rows;
  console.log(`${rows.map(row => row.name).join(", ")} now use ${url.origin}${apiPrefix}`);
  // Clearing the inventory makes the app re-probe before it trusts readiness — which also hides
  // capability tabs until that probe lands. Name the command so the gap lasts seconds, not minutes.
  for (const row of rows) console.log(`Next: npm run worker:remote probe ${row.id}   (otherwise the app's own monitor fills this in within about a minute)`);
} finally {
  await pool.end();
}

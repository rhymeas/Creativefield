// One read-only view of the installation: app, worker, memory gate, library and the last outputs.
// Usage: node --env-file=.comfyfield/app.env scripts/status.mjs
import pg from "pg";

const API = process.env.COMFYFIELD_API ?? "http://127.0.0.1:8787/api/v1";
const WORKSPACE = process.env.COMFYFIELD_WORKSPACE;
const MIN_SHARE = (() => {
  const raw = process.env.COMFYFIELD_MIN_FREE_RAM_SHARE;
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value >= 0.02 && value <= 0.95 ? value : 0.15;
})();
const jar = new Map();
const gb = bytes => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

async function api(method, path) {
  const headers = {origin: new URL(API).origin};
  if (jar.size) headers.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  const response = await fetch(API + path, {method, headers});
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair] = value.split(";");
    const index = pair.indexOf("=");
    jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return response;
}

const lines = [];
try {
  const health = await (await fetch(API.replace(/\/api\/v1$/, "") + "/api/v1/health")).json();
  lines.push(`app        ${health.status} at ${API.replace(/\/api\/v1$/, "")}`);
} catch (error) {
  lines.push(`app        not answering at ${API.replace(/\/api\/v1$/, "")} — start it with npm start`);
}

let workers = [];
try {
  await api("GET", "/auth/me");
  const workspaceId = WORKSPACE ?? (await (await api("GET", "/workspaces")).json())[0]?.id;
  workers = await (await api("GET", `/workspaces/${workspaceId}/workers`)).json();
  for (const worker of workers) {
    const hardware = worker.inventory?.hardware;
    const share = hardware?.ramFree != null && hardware?.ramTotal ? hardware.ramFree / hardware.ramTotal : null;
    const gate = share === null ? "unknown" : share > MIN_SHARE ? "open" : `held (${(share * 100).toFixed(1)} % free, needs over ${(MIN_SHARE * 100).toFixed(0)} %)`;
    lines.push(`worker     ${worker.enabled ? "enabled" : "disabled"}  ${worker.name}  ${worker.origin}  online=${worker.inventory?.online ?? "?"}  nodes=${worker.inventory?.nodes?.length ?? 0} models=${worker.inventory?.models?.length ?? 0}`);
    if (hardware) lines.push(`memory     ${gb(hardware.ramFree)} free of ${gb(hardware.ramTotal)} — gate ${gate}`);
  }
} catch (error) {
  lines.push(`workers    could not read (${error.message})`);
}

if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
  try {
    const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
    const [runs] = await q("SELECT count(*)::int AS total, count(*) FILTER (WHERE state='succeeded')::int AS ok, count(*) FILTER (WHERE state='failed')::int AS bad FROM runs WHERE workspace_id=$1", [WORKSPACE ?? (await q("SELECT id FROM workspaces LIMIT 1"))[0]?.id]);
    const [assets] = await q("SELECT count(*)::int AS total FROM assets");
    const [newest] = await q("SELECT media_type, bytes, to_char(created_at,'YYYY-MM-DD HH24:MI') AS at FROM assets ORDER BY created_at DESC LIMIT 1");
    lines.push(`runs       ${runs.total} total, ${runs.ok} succeeded, ${runs.bad} failed`);
    lines.push(`library    ${assets.total} assets` + (newest ? `, newest ${newest.media_type} (${gb(newest.bytes)}, ${newest.at})` : ""));
  } catch (error) {
    lines.push(`database   could not read (${error.message})`);
  } finally {
    await pool.end();
  }
} else {
  lines.push("database   DATABASE_URL not set — run with --env-file=.comfyfield/app.env");
}

console.log(lines.join("\n"));

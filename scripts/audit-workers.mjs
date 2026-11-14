// Adding a worker, probing it and removing it must all work, and a bad address must say what to fix.
// The removal route only exists because a mistyped worker used to be permanent — this keeps it honest.
// Usage: npm run audit:workers (the app must be running).
const API = (process.env.COMFYFIELD_API ?? "http://127.0.0.1:8787/api/v1").replace(/\/$/, "");
const ORIGIN = new URL(API).origin;
const jar = new Map();

const healthy = await fetch(`${ORIGIN}/api/v1/health`).then(r => r.ok).catch(() => false);
if (!healthy) {
  console.log(`the app is not answering at ${ORIGIN} — start it with npm start, then run this again.`);
  process.exit(1);
}

async function call(method, path, body) {
  const headers = {origin: ORIGIN};
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(API + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair] = value.split(";"); const i = pair.indexOf("="); jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const text = await response.text();
  return {status: response.status, body: text ? JSON.parse(text) : null};
}

await call("GET", "/auth/me");
const [workspace] = (await call("GET", "/workspaces")).body ?? [];
if (!workspace) { console.log("no workspace found — start the app first."); process.exit(1); }
const base = `/workspaces/${workspace.id}/workers`;
const before = ((await call("GET", base)).body ?? []).length;

const problems = [];
const check = (ok, label, detail) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) problems.push(label); };

const bad = await call("POST", base, {name: "Audit", origin: "/not-an-origin", apiPrefix: "/api"});
const badMessage = String(bad.body?.error ?? "");
check(bad.status === 400 && badMessage !== "Invalid request" && /http/i.test(badMessage),
  "a bad address explains what a good one looks like", `${bad.status} "${badMessage}"`);

const added = await call("POST", base, {name: "Audit probe", origin: "http://127.0.0.1:9", apiPrefix: "/api"});
check(added.status === 200 && !!added.body?.id, "a worker can be registered", `HTTP ${added.status}`);
if (added.body?.id) {
  const probe = await call("POST", `${base}/${added.body.id}/probe`);
  check(probe.body?.inventory?.online === false, "an unreachable worker probes as offline", `online=${probe.body?.inventory?.online}`);
  const removed = await call("DELETE", `${base}/${added.body.id}`);
  check(removed.status === 200, "a registered worker can be removed", `HTTP ${removed.status}`);
  const again = await call("DELETE", `${base}/${added.body.id}`);
  check(again.status === 404, "removing it twice says not found", `HTTP ${again.status}`);
}
const after = ((await call("GET", base)).body ?? []).length;
check(after === before, "the workspace is left as it was found", `${before} workers before, ${after} after`);

console.log(`\nworker checks: 5, failing: ${problems.length}`);
process.exit(problems.length ? 1 : 0);

// Point ComfyField at a ComfyUI that runs somewhere else (a rented GPU, another box).
// Usage:
//   node scripts/worker-remote.mjs list
//   node scripts/worker-remote.mjs add <name> <origin> [--api-prefix=/api]
//   node scripts/worker-remote.mjs probe <workerId>
//   node scripts/worker-remote.mjs point <origin> [--api-prefix=/api]   repoints the enabled worker
// Reads the workspace from COMFYFIELD_WORKSPACE or the first workspace of the local studio.
const API = (process.env.COMFYFIELD_API ?? "http://127.0.0.1:8787/api/v1").replace(/\/$/, "");
const ORIGIN_HEADER = {origin: new URL(API).origin};
const jar = new Map();

async function call(method, path, body) {
  const headers = {...ORIGIN_HEADER};
  if (jar.size) headers.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(API + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair] = value.split(";");
    const index = pair.indexOf("=");
    jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const [command, ...args] = process.argv.slice(2);
const flag = name => {
  const index = args.findIndex(value => value.startsWith(`--${name}`));
  if (index < 0) return undefined;
  const [key, value] = args[index].split("=");
  args.splice(index, 1);
  return value ?? args[index];
};

await call("GET", "/auth/me");
const workspaces = await call("GET", "/workspaces");
const workspaceId = process.env.COMFYFIELD_WORKSPACE ?? workspaces[0]?.id;
if (!workspaceId) throw new Error("No workspace found; start the app first.");

const report = workers => {
  for (const worker of workers) {
    const hardware = worker.inventory?.hardware ?? {};
    const free = hardware.ramFreeGb ?? null;
    const total = hardware.ramTotalGb ?? null;
    console.log(`${worker.enabled ? "on " : "off"}  ${worker.name.padEnd(24)} ${worker.origin.padEnd(44)} online=${worker.inventory?.online ?? "?"}` + (free !== null ? `  RAM ${free}/${total} GB` : ""));
  }
};

if (command === "list" || !command) {
  console.log(`workspace ${workspaceId}`);
  report(await call("GET", `/workspaces/${workspaceId}/workers`));
} else if (command === "add") {
  const [name, origin] = args;
  if (!name || !origin) throw new Error("Usage: add <name> <origin>");
  const apiPrefix = flag("api-prefix") ?? "/api";
  const created = await call("POST", `/workspaces/${workspaceId}/workers`, {name, origin, apiPrefix});
  console.log(`added ${created.name} (${created.id}) at ${created.origin}`);
  const probed = await call("POST", `/workspaces/${workspaceId}/workers/${created.id}/probe`);
  report([{...created, inventory: probed.inventory, enabled: true}]);
  const ready = (probed.capabilities ?? []).filter(capability => capability.readiness.state === "ready").length;
  console.log(`${ready} of ${probed.capabilities?.length ?? 0} capabilities ready on that worker`);
  if (!probed.inventory?.online) console.log("It is not answering yet. Check the URL, that ComfyUI is running, and that the port is reachable from this machine.");
} else if (command === "free") {
  // Ask the worker to unload models, but only when it is idle: the app refuses the same way,
  // because freeing a worker mid-job would kill the job.
  const workers = await call("GET", `/workspaces/${workspaceId}/workers`);
  const worker = workers.find(item => item.enabled);
  if (!worker) throw new Error("No enabled worker.");
  const base = worker.origin.replace(/\/$/, "") + (worker.api_prefix ?? "/api");
  const queue = await (await fetch(`${base}/queue`)).json().catch(() => null);
  if (!queue || !Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new Error(`${worker.name} did not answer /queue.`);
  if (queue.queue_running.length || queue.queue_pending.length) {
    console.log(`${worker.name} is busy (${queue.queue_running.length} running, ${queue.queue_pending.length} queued); not freeing it.`);
  } else {
    const response = await fetch(`${base}/free`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({unload_models: true, free_memory: true})});
    console.log(`free requested on ${worker.name}: HTTP ${response.status}`);
  }
  const stats = await (await fetch(`${base}/system_stats`)).json().catch(() => null);
  const system = stats?.system;
  if (system?.ram_total) console.log(`free RAM now ${Math.round(system.ram_free / 1e9)} of ${Math.round(system.ram_total / 1e9)} GB (${Math.round((system.ram_free / system.ram_total) * 100)} %)`);
  await call("POST", `/workspaces/${workspaceId}/workers/${worker.id}/probe`);
} else if (command === "probe") {
  const [workerId] = args;
  if (!workerId) throw new Error("Usage: probe <workerId>");
  const probed = await call("POST", `/workspaces/${workspaceId}/workers/${workerId}/probe`);
  console.log(`online=${probed.inventory?.online} nodes=${probed.inventory?.nodes?.length ?? 0} models=${probed.inventory?.models?.length ?? 0}`);
  for (const capability of probed.capabilities ?? []) {
    if (capability.readiness.state !== "ready") console.log(`  ${capability.id}: ${capability.readiness.state} — ${capability.readiness.reasons?.[0] ?? ""}`);
  }
} else if (command === "point") {
  // No PATCH route exists for workers, so the enabled worker's origin is rewritten through the
  // same database path scripts/worker-target.mjs uses.
  const [origin] = args;
  if (!origin) throw new Error("Usage: point <origin>");
  const {execFileSync} = await import("node:child_process");
  const output = execFileSync("node", ["--env-file=.comfyfield/app.env", "scripts/worker-point.mjs", origin, ...(flag("api-prefix") ? [flag("api-prefix")] : [])], {encoding: "utf8"});
  console.log(output.trim());
} else {
  throw new Error(`Unknown command ${command}. Use list, add, probe or point.`);
}

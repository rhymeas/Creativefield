// Start script for the Railway try-out. Reads Railway's own variables, creates the guest account once,
// starts the server and fills the library with the example pictures and clips on the first start.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const env = { ...process.env };
if (!env.DATABASE_URL) { console.error("Missing variable DATABASE_URL. See docs/RAILWAY.md."); process.exit(1); }
env.PORT = env.PORT || "8080";
env.STORAGE_ROOT = env.STORAGE_ROOT || "/data";
mkdirSync(env.STORAGE_ROOT, { recursive: true });
if (!env.PUBLIC_ORIGIN) {
  const domain = env.RAILWAY_PUBLIC_DOMAIN;
  if (!domain) { console.error("Set PUBLIC_ORIGIN, or give the service a Railway public domain first."); process.exit(1); }
  env.PUBLIC_ORIGIN = `https://${domain}`;
}
/* The node editor listens on its own port, which a public host cannot reach: it stays internal. */
env.NODE_EDITOR_PORT = env.NODE_EDITOR_PORT || "8788";
{ const editor = new URL(env.PUBLIC_ORIGIN); editor.port = env.NODE_EDITOR_PORT; env.NODE_EDITOR_ORIGIN = env.NODE_EDITOR_ORIGIN || editor.origin; }
/* The key that protects stored credentials: from the variable, else one made on the first start and kept on the volume. */
if (!env.MASTER_KEY) {
  const keyFile = path.join(env.STORAGE_ROOT, "master.key");
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString("base64"), { mode: 0o600 });
  env.MASTER_KEY = readFileSync(keyFile, "utf8").trim();
}
/* Open only when the operator sets OPEN_ACCESS=1: every visitor is then signed in automatically to one shared demo workspace
   (single-user mode). Otherwise BOOTSTRAP_EMAIL / BOOTSTRAP_PASSWORD create a guest account behind the sign-in wall. Workers pointing inside the host stay refused
   either way (COMFYFIELD_PUBLIC_TRYOUT). */
const open = env.OPEN_ACCESS === "1";
if (!open && !(env.BOOTSTRAP_EMAIL && env.BOOTSTRAP_PASSWORD)) { console.error("Choose: OPEN_ACCESS=1 (no sign-in, shared demo) or BOOTSTRAP_EMAIL + BOOTSTRAP_PASSWORD (guest account). See docs/RAILWAY.md."); process.exit(1); }
if (open) env.LOCAL_SINGLE_USER = "1"; else delete env.LOCAL_SINGLE_USER;

const run = (args, extra = {}) => new Promise((resolve) => { const c = spawn(process.execPath, args, { env: { ...env, ...extra }, stdio: "inherit" }); c.on("exit", (code) => resolve(code ?? 1)); });

if (!open && env.BOOTSTRAP_EMAIL && env.BOOTSTRAP_PASSWORD) {
  const code = await run(["--import", "tsx", "server/bootstrap.ts"], { BOOTSTRAP_WORKSPACE: env.BOOTSTRAP_WORKSPACE || "CreativeField try-out" });
  if (code !== 0) console.log("Guest account already exists (or could not be created); continuing.");
}

const server = spawn(process.execPath, ["--import", "tsx", "server/main.ts"], { env, stdio: "inherit" });
server.on("exit", (code) => process.exit(code ?? 1));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.kill(sig));

/* First start only: upload the examples into the guest's library so FotoField and the tools have something to pick. */
const marker = path.join(env.STORAGE_ROOT, ".seeded");
if (!existsSync(marker) && (open || (env.BOOTSTRAP_EMAIL && env.BOOTSTRAP_PASSWORD))) {
  const api = `http://127.0.0.1:${env.PORT}/api/v1`, origin = new URL(env.PUBLIC_ORIGIN).origin;
  for (let i = 0; i < 90; i++) { try { if ((await fetch(`${api}/health`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 1000)); }
  try {
    /* Open mode: the first visit signs in and creates the shared workspace. Guest mode: sign in with the guest account. */
    const login = open ? await fetch(`${api}/auth/me`, { headers: { origin } }) : await fetch(`${api}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ email: env.BOOTSTRAP_EMAIL.toLowerCase().trim(), password: env.BOOTSTRAP_PASSWORD }) });
    if (!login.ok) throw new Error(`login ${login.status}`);
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const call = async (p, init = {}) => { const r = await fetch(`${api}${p}`, { ...init, headers: { origin, cookie, ...(init.headers ?? {}) } }); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json(); };
    const workspaces = await call("/workspaces"), wid = workspaces[0].id;
    const projects = await call(`/workspaces/${wid}/projects`);
    const project = projects[0] ?? await call(`/workspaces/${wid}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Studio demo" }) });
    const pool = JSON.parse(readFileSync("public/examples/pool.json", "utf8"));
    const files = [
      ...pool.images.map((f) => ({ file: path.join("public/examples", f), kind: "image", type: "image/webp" })),
      ...readdirSync("public/reels").filter((f) => /^mj-\d+\.mp4$/.test(f)).map((f) => ({ file: path.join("public/reels", f), kind: "video", type: "video/mp4" })),
    ];
    let ok = 0;
    for (const item of files) {
      const form = new FormData();
      form.append("file", new Blob([readFileSync(item.file)], { type: item.type }), path.basename(item.file));
      const r = await fetch(`${api}/workspaces/${wid}/assets?projectId=${project.id}&kind=${item.kind}`, { method: "POST", headers: { origin, cookie }, body: form });
      if (r.ok) ok++;
    }
    writeFileSync(marker, String(ok));
    console.log(`Library filled with ${ok} example files.`);
  } catch (error) { console.error(`Library seeding skipped: ${error.message}`); }
}

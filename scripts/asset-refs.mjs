// Every asset the UI refers to must actually be served. Two 404s hid here for months — a missing
// favicon and a missing demo wav — because nothing checked the join between the code and the
// published directories (/assets and /reels). Usage: npm run audit:assets (app must be running).
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.COMFYFIELD_API?.replace(/\/api\/v1$/, "") ?? "http://127.0.0.1:8787";
const PUBLISHED = ["/assets/", "/reels/"];

const refs = new Map();
const walk = dir => {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!/\.(tsx?|jsx?)$/.test(entry.name)) continue;
    const text = fs.readFileSync(full, "utf8");
    for (const match of text.matchAll(/["'`](\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|webp|svg|wav|mp3|mp4|webm|glb))["'`]/g)) {
      if (!refs.has(match[1])) refs.set(match[1], full);
    }
  }
};
if (fs.existsSync("src")) walk("src");

let failing = 0, unreachable = 0;
for (const [url, file] of [...refs].sort()) {
  const response = await fetch(BASE + url).catch(() => null);
  const status = response?.status ?? 0;
  const published = PUBLISHED.some(prefix => url.startsWith(prefix));
  if (status === 200) continue;
  if (status === 0) { unreachable++; continue; }
  failing++;
  console.log(`  ${String(status).padEnd(4)} ${url}  (used in ${file})${published ? "" : " — and not under a published prefix"}`);
}
/* "0 missing" and "cannot reach the app" are different answers: reporting eight missing files when
   the server is simply down sends someone hunting files that are present. */
if (unreachable && unreachable === refs.size) {
  console.log(`the app is not answering at ${BASE} — start it with npm start, then run this again.`);
  process.exit(1);
}
console.log(`assets referenced by the UI: ${refs.size}, failing: ${failing}${unreachable ? `, unreachable: ${unreachable}` : ""}`);
console.log(`published prefixes: ${PUBLISHED.join(", ")} — a file outside them must move or get a route.`);
process.exit(failing || unreachable ? 1 : 0);

// Every resource a person can create should have a way to remove it, or an explicit reason why not.
// Found three times by hand — workers, characters, storyboards — so it is checked instead.
// Usage: npm run audit:removal
import {readdirSync, readFileSync} from "node:fs";
import path from "node:path";

/* Creates that are actions rather than records: a run is history, a preview is a probe, an import is a
   one-shot conversion. None of them should offer a delete, and each is listed so the silence is a
   decision instead of an oversight. */
const ACTIONS = new Set([
  "runs", "renders", "storyboard-renders", "storyboard-renders/:id/retry-assembly", "preview", "hub-check",
  "imports", "pose-previews", "audio-operations", "video-extension-plans", "video-extensions",
  "feature-edit", "script-revisions", "voice-element-revisions", "assets",
]);

/* Known gaps with a decision still to make. Listing them here keeps the check honest: it fails on a
   NEW create-without-remove, and prints these as pending rather than pretending they are fine. */
const PENDING = new Map([
  ["brand-kits", "marketing record — decide provenance (archive) or scratch (delete)"],
  ["briefs", "marketing record — same question"],
  ["products", "marketing record — same question"],
  ["elements", "the reusable record behind characters; removal happens through the character route"],
]);

const sources = readdirSync("server", {recursive: true}).filter(name => name.endsWith(".ts"));
const creates = new Map(), removes = new Map();
for (const relative of sources) {
  const text = readFileSync(path.join("server", relative), "utf8");
  for (const match of text.matchAll(/app\.post\(`\$\{base\}\/([^`]+)`/g)) creates.set(match[1], relative);
  for (const match of text.matchAll(/app\.delete\(`\$\{base\}\/([^`]+)`/g)) removes.set(match[1], relative);
}

const problems = [], pending = [];
let checked = 0, exempt = 0;
for (const [route, file] of [...creates].sort()) {
  /* A path that opens with a parameter is not a collection — it is one id inside a larger route
     (/workflows/:id/imports). Those are actions on an existing thing, not new resources. */
  if (route.startsWith(":")) { exempt++; continue; }
  const resource = route.split("/")[0];
  if (ACTIONS.has(route) || ACTIONS.has(resource)) { exempt++; continue; }
  checked++;
  const hasRemove = [...removes.keys()].some(candidate => candidate.split("/")[0] === resource);
  if (hasRemove) continue;
  if (PENDING.has(resource)) pending.push(`${resource} — ${PENDING.get(resource)}`);
  else problems.push(`${resource} (created in server/${file}, no delete route)`);
}

console.log(`creates that are resources: ${checked}, actions exempt: ${exempt}`);
console.log(`resources with a delete route: ${[...new Set([...removes.keys()].map(r => r.split("/")[0]))].sort().join(", ")}`);
for (const line of pending) console.log(`  pending  ${line}`);
for (const problem of problems) console.log(`  NO REMOVAL ${problem}`);
console.log(problems.length
  ? `\nnew create-without-remove: ${problems.length}`
  : `\nno new gaps; ${pending.length} tracked as pending`);
process.exit(problems.length ? 1 : 0);

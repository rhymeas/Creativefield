// Check that every documented npm command and script path exists.
import fs from "node:fs";
import path from "node:path";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const scripts = new Set(Object.keys(pkg.scripts ?? {}));
const docs = ["README.md", "docs/INSTALL-BACKUP-RECOVERY.md", "docs/DEMO-SCRIPT.md", "docs/EVIDENCE-INDEX.md", "docs/PARITY-STATUS.md", "NEXT-STEPS.md"];
const seen = new Map();
/* "npm command" and "npm script" are prose, not invocations: without this stoplist the checker
   reports a missing script called "command" and exits 1 on a healthy repository. */
const prose = new Set(["command", "commands", "script", "scripts", "package", "version", "install", "run"]);
for (const doc of docs) {
  if (!fs.existsSync(doc)) continue;
  const text = fs.readFileSync(doc, "utf8");
  for (const match of text.matchAll(/npm (?:run )?([a-z][\w:-]*)/g)) {
    const name = match[1];
    if (prose.has(name)) continue;
    if (["install", "ci", "test", "start", "exec", "init"].includes(name) && name === match[1]) { seen.set(name, doc); continue; }
    seen.set(name, doc);
  }
}
const builtin = new Set(["install", "ci", "exec", "init"]);
const missing = [...seen].filter(([name]) => !builtin.has(name) && !scripts.has(name));
console.log(`scripts in package.json: ${scripts.size}`);
for (const [name, doc] of [...seen].sort()) {
  const ok = builtin.has(name) || scripts.has(name);
  console.log(`  ${ok ? "ok  " : "MISS"} npm ${name}${ok ? "" : `  (mentioned in ${doc})`}`);
}
const files = new Set();
for (const doc of docs) {
  if (!fs.existsSync(doc)) continue;
  const text = fs.readFileSync(doc, "utf8");
  for (const match of text.matchAll(/[`(](\.?\/?(?:scripts|server|test|src)\/[\w./-]+\.(?:mjs|cjs|ts|tsx|js))[`)]/g)) files.add(match[1]);
}
const missingFiles = [...files].filter(file => !fs.existsSync(file.replace(/^\.\//, "")));
console.log(`\nreferenced files: ${files.size}, missing: ${missingFiles.length}`);
for (const file of missingFiles) console.log(`  MISSING ${file}`);

/* Markdown links and images are how a reader moves through the documents. A renamed screenshot or
   a doc that moved breaks the path silently, and the page still looks fine to whoever wrote it. */
const links = new Set();
const scan = [...docs, "docs/SUBMISSION-CHECKLIST.md", "docs/OFFLOAD-GPU.md", "docs/UI-ROUTE-AUDIT.md", "docs/PERFORMANCE.md", "docs/DESIGN-COVERAGE.md"];
for (const doc of scan) {
  if (!fs.existsSync(doc)) continue;
  const text = fs.readFileSync(doc, "utf8");
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const [file] = target.split("#");
    if (!file) continue;
    links.add(path.normalize(path.join(path.dirname(doc), file)));
  }
}
const missingLinks = [...links].filter(file => !fs.existsSync(file));
console.log(`links and images: ${links.size}, missing: ${missingLinks.length}`);
for (const file of missingLinks) console.log(`  MISSING ${file}`);

/* Claims that were true once and stopped being true. Each entry says what the code does now, because
   a stale sentence is worse than no sentence: it reads as a promise that a feature is absent.
   Historical records (INDEPENDENT-PRODUCTION, SESSION-LOG, slice documents) are deliberately not
   scanned: they describe the state on their date. */
const STALE = [
  ["no cross-fades", "assembly has opt-in cross-fade joins (assembly.transition)"],
  ["About 15 minutes per face", "the panel quotes the measured median, about 8 minutes"],
  ["Objects swap (products and clothes, not just people) isn't built", "the Swap a thing card does it with VACE masked edit"],
  ["transitions/continuity open", "cross-fades are opt-in now; continuity is still open"],
  ["transitions are hard cuts", "hard cuts are the default; cross-fades are a setting"],
];
const currentState = scan.filter(doc => !/INDEPENDENT-PRODUCTION|SESSION-LOG|FILMMAKING-S30-S38|storyboard-design-advice|HANDOFF-/.test(doc));
const stale = [];
/* A correction quotes the wording it replaced ("the copy said \"no cross-fades\""), so a phrase inside
   quotation marks is a record of the old claim, not a live one. Only bare statements count. */
const quoteLeft = /["“']/, quoteRight = /["”']/;
for (const doc of currentState) {
  if (!fs.existsSync(doc)) continue;
  for (const [index, line] of fs.readFileSync(doc, "utf8").split("\n").entries()) {
    const lower = line.toLowerCase();
    for (const [phrase, why] of STALE) {
      const at = lower.indexOf(phrase.toLowerCase());
      if (at < 0) continue;
      if (quoteLeft.test(line.slice(0, at)) && quoteRight.test(line.slice(at + phrase.length))) continue;
      stale.push(`${doc}:${index + 1}: "${phrase}" — ${why}`);
    }
  }
}
console.log(`stale claims: ${stale.length}`);
for (const line of stale) console.log(`  STALE ${line}`);
if (missing.length || missingFiles.length || missingLinks.length || stale.length) process.exit(1);

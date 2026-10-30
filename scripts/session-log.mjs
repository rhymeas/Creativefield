// Collect this session's commits and their bodies into a reviewable log.
import {execFileSync} from "node:child_process";
import fs from "node:fs";

const AUTHOR = "ComfyField";
const separator = "\u001f";
const log = execFileSync("git", ["log", `--author=${AUTHOR}`, "--reverse", `--pretty=format:%h${separator}%ad${separator}%s${separator}%b${separator}`, "--date=short"], {encoding: "utf8"});
const entries = log.split(separator).reduce((rows, value, index, all) => {
  if (index % 4 === 0 && index + 3 < all.length) rows.push({hash: value.trim(), date: all[index + 1]?.trim(), subject: all[index + 2]?.trim(), body: (all[index + 3] ?? "").trim()});
  return rows;
}, []).filter(entry => entry.hash && entry.subject);

const features = entries.filter(entry => /^feat/.test(entry.subject));
const fixes = entries.filter(entry => /^fix/.test(entry.subject));
const docs = entries.filter(entry => /^docs|^checkpoint/.test(entry.subject));
const tests = entries.filter(entry => /^test/.test(entry.subject));

const section = (title, rows) => rows.length ? [`## ${title} (${rows.length})`, "", ...rows.map(entry => `- \`${entry.hash}\` ${entry.subject.replace(/^[a-z]+: /, "")}`), ""].join("\n") : "";

const out = [
  "# Session log",
  "",
  `Commits authored in this workstream: **${entries.length}** (${features.length} features, ${fixes.length} fixes, ${tests.length} tests, ${docs.length} documentation or checkpoint).`,
  "The ledger (`NEXT-STEPS.md`) holds the reasoning behind each; the documents named there hold the evidence.",
  "",
  section("Features", features),
  section("Fixes", fixes),
  section("Tests", tests),
  section("Documentation and checkpoints", docs),
].filter(Boolean).join("\n");

fs.writeFileSync("docs/SESSION-LOG.md", out, "utf8");
console.log(`wrote docs/SESSION-LOG.md with ${entries.length} commits (${features.length} features, ${fixes.length} fixes)`);

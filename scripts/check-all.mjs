// Every readiness check in one command, with one verdict. Usage: npm run check:all
// Each step is an existing npm script; this only orders them and reports honestly.
import {spawnSync} from "node:child_process";

const steps = [
  ["doctor", "preflight: Node, licence, build, config, models, ComfyUI, PostgreSQL"],
  ["smoke", "the worker answers and can run video pipelines"],
  ["docs:check", "every documented command, path, link and image exists"],
  ["audit:assets", "every asset the UI refers to is served"],
  ["audit:links", "every mode opens the same by address as by tab"],
  ["audit:claims", "the parity counts match the live catalogue"],
  ["audit:workers", "a worker can be added, probed and removed"],
  ["audit:removal", "nothing can be created without a way to remove it"],
  ["demo:check", "the demo outputs and reel are in place"],
];

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const results = [];
for (const [script, what] of steps) {
  process.stdout.write(`\n── npm run ${script} — ${what}\n`);
  const run = spawnSync(npm, ["run", script], {stdio: "inherit", shell: process.platform === "win32"});
  results.push({script, code: run.status ?? 1});
}

console.log("\n── verdict");
for (const row of results) console.log(`  ${row.code === 0 ? "ok  " : "FAIL"} npm run ${row.script}`);
const failed = results.filter(row => row.code !== 0);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed.` : `\nAll ${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);

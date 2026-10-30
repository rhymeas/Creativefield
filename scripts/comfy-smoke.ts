// Phase 0 check: is ComfyUI reachable, which routes work, and can it run video pipelines?
// Usage: npm run smoke            (default http://127.0.0.1:8188)
//        COMFY_URL=http://host:8188 npm run smoke
import { probe } from "../src/comfy/probe";

const base = (process.env.COMFY_URL ?? "http://127.0.0.1:8188").replace(/\/$/, "");
const report = await probe(base);

console.log(`\nComfyUI smoke check: ${report.base}`);
if (report.gpu) {
  console.log(`GPU: ${report.gpu.name}, ${report.gpu.vramFreeGB} of ${report.gpu.vramTotalGB} GB free\n`);
}
for (const c of report.checks) {
  const mark = c.ok ? "PASS" : c.required ? "FAIL" : "warn";
  console.log(`  ${mark}  ${c.label.padEnd(44)} ${c.detail}`);
}
console.log(`\nResult: ${report.ok ? "ready" : "NOT ready"}\n`);
process.exit(report.ok ? 0 : 1);

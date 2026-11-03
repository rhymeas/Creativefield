// Converts a ComfyUI UI-format workflow into an API-format template using the live server's
// node definitions.
// Usage: npm run ui-to-api -- <in.ui.json> <out.api.json> [--enable 56,57]
//   --enable   node IDs that are bypassed in the template but should run
import { readFileSync, writeFileSync } from "node:fs";
import { uiToApi, type ObjectInfo, type UiWorkflow } from "../src/workflow/ui-to-api";

const [input, output, ...rest] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: npm run ui-to-api -- <in.ui.json> <out.api.json> [--enable 56,57]");
  process.exit(2);
}
const enableArg = rest[rest.indexOf("--enable") + 1];
const enable = rest.includes("--enable") && enableArg ? enableArg.split(",").map((s) => (/^\d+$/.test(s) ? Number(s) : s)) : [];

const base = (process.env.COMFY_URL ?? "http://127.0.0.1:8188").replace(/\/$/, "");
const info = (await (await fetch(`${base}/api/object_info`)).json()) as ObjectInfo;
const ui = JSON.parse(readFileSync(input, "utf8")) as UiWorkflow;

const graph = uiToApi(ui, info, { enable });
writeFileSync(output, JSON.stringify(graph, null, 2) + "\n");
console.log(`wrote ${output}: ${Object.keys(graph).length} nodes (enabled: ${enable.join(", ") || "none"})`);

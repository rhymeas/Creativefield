// Checks every native workflow against a ComfyUI's node definitions, without a GPU and without
// queueing anything: missing node packs, dropdown values the server does not offer (usually a
// model file), links to nodes that are not there, numbers outside a node's limits.
//
//   npm run validate:workflows                       (ComfyUI at http://127.0.0.1:8188)
//   COMFY_URL=http://host:8188 npm run validate:workflows
//
// With no ComfyUI reachable only the structure is checked, and the report says so.
// Exit code 1 when any workflow has a problem the server would reject.
import { loadServerCatalogue } from "../server/catalogue";
import { summariseIssues, validateGraph } from "../src/workflow/validate-graph";
import type { ObjectInfo } from "../src/workflow/ui-to-api";

const base = (process.env.COMFY_URL ?? "http://127.0.0.1:8188").replace(/\/$/, "");

async function fetchInfo(): Promise<ObjectInfo | null> {
  try {
    const response = await fetch(`${base}/object_info`, { signal: AbortSignal.timeout(30_000) });
    return response.ok ? await response.json() as ObjectInfo : null;
  } catch {
    return null;
  }
}

const info = await fetchInfo();
const catalogue = await loadServerCatalogue({ log: () => undefined });
console.log(info ? `\nValidating against ${base} (${Object.keys(info).length} node classes)\n` : `\nNo ComfyUI answered at ${base}: structure only, node and model checks skipped\n`);

let failed = 0, checked = 0;
for (const { manifest, template } of catalogue) {
  if (!template) continue;
  checked++;
  const skip = new Set([...manifest.inputs, ...manifest.controls].flatMap(item => item.binding ? [`${item.binding.node}.${item.binding.field}`] : []));
  /* A replace pack's stored template is a fragment: the native compiler adds the relay windows
     and their links at run time, so a link to a node that is not stored is expected there. */
  const compiled = manifest.replaceContract !== undefined;
  const issues = validateGraph(template, info, skip).filter(issue => !(compiled && issue.kind === "bad_link"));
  if (!issues.length) { console.log(`  ${compiled ? "partial" : "ok     "}   ${manifest.id}${compiled ? "  (compiled at run time, links not checked)" : ""}`); continue; }
  const { nodes, options, other } = summariseIssues(issues);
  const hard = nodes.length > 0 || other.length > 0;
  if (hard) failed++;
  console.log(`  ${hard ? "FAIL" : "models"}   ${manifest.id}`);
  if (nodes.length) console.log(`             node packs missing: ${nodes.join(", ")}`);
  if (options.length) console.log(`             not offered: ${options.slice(0, 6).join("; ")}${options.length > 6 ? ` (+${options.length - 6})` : ""}`);
  for (const issue of other.slice(0, 6)) console.log(`             ${issue.kind} ${issue.nodeClass}#${issue.node}: ${issue.detail}`);
}
console.log(`\n${checked} workflows with a template, ${failed} with a problem the server would reject.\n`);
process.exit(failed ? 1 : 0);

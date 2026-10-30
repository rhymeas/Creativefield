// Checks a ComfyHub or Comfy-Org workflow against a running ComfyUI without importing it.
// Usage: npx tsx scripts/hub-check.ts <https address> [comfy origin]
import { fetchHubWorkflow, hubReadiness } from "../server/hub-source";
import { previewWorkflowImport, WorkflowImportError } from "../server/workflow-import";

const [address, origin = "http://127.0.0.1:8188"] = process.argv.slice(2);
if (!address) { console.error("Give a workflow address"); process.exit(2); }
const hub = await fetchHubWorkflow(address);
const objectInfo = await (await fetch(`${origin}/object_info`)).json();
const readiness = hubReadiness(hub.ui, objectInfo);
console.log(JSON.stringify({ url: hub.url, bytes: hub.raw.length, readiness }, null, 1));
try {
  const result = previewWorkflowImport({ name: "hub-check", ui: hub.ui, objectInfo });
  console.log("converts:", Object.keys(result.graph).length, "API nodes; inputs", result.mapping.inputs.map((i) => i.port), "controls", result.mapping.controls.map((c) => c.control));
} catch (error) {
  console.log("does not convert:", error instanceof WorkflowImportError ? error.errors : (error as Error).message);
}

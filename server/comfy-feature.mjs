/** Runs only inside the isolated ComfyUI origin. Opens a ComfyField feature's graph for editing; never queues or saves by itself. */
const FEATURE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function parseFeature(search) {
  const value = new URLSearchParams(search).get("comfyfield_feature");
  return value && FEATURE_ID.test(value) ? value : null;
}

export function workspaceFromPath(pathname) {
  return /^\/comfy\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i.exec(pathname)?.[1] ?? null;
}

function comfyApp() {
  return window.comfyAPI?.app?.app ?? window.app;
}

async function whenReady(timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const app = comfyApp();
    if (app?.graph && typeof app.loadGraphData === "function") return app;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("The node editor did not become ready.");
}

/** Waits until the workflow store is idle (session restore done), then a moment longer for the last tab switch. */
async function settled(app, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const store = app.extensionManager?.workflow;
    if (store?.activeWorkflow && !store.isBusy && !store.isSyncLoading && !store.activeWorkflow.isLoading) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

async function open() {
  const feature = parseFeature(location.search), workspace = workspaceFromPath(location.pathname);
  if (!feature || !workspace) return;
  const app = await whenReady();
  const response = await fetch(`/comfyfield-feature-graph/${workspace}/${feature}`, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Feature graph unavailable (${response.status})`);
  const { name, workflow } = await response.json();
  // A complete editor workflow (links included). Its name becomes the default save name, so "Apply edits" in
  // ComfyField can find it again; extra.comfyfield.ids lets ComfyField map node ids back to the feature's own.
  // The editor restores the previous session's tabs after start-up; loading before that finishes loses our tab.
  await settled(app);
  for (let attempt = 0; attempt < 2; attempt++) {
    await app.loadGraphData(workflow, true, true, name);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if ((app.graph.serialize().links ?? []).length >= workflow.links.length) return;
  }
}

if (typeof window !== "undefined") open().catch((error) => console.warn("[ComfyField]", error.message));

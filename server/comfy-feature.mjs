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

/** A link count can match an unrelated tab. Verify the selected feature's marker, nodes and connections. */
export function loadedFeatureMatches(serialized, workflow) {
  const expected = workflow?.extra?.comfyfield?.ids;
  const actual = serialized?.extra?.comfyfield?.ids;
  if (!expected || !actual) return false;
  const entries = (value) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  const nodes = (value) => (value?.nodes ?? []).map((node) => [String(node.id), node.type]).sort(([a], [b]) => a.localeCompare(b));
  /* ComfyUI rebuilds widget sockets while loading. That can move a linked socket to a different
     numeric slot even though it still feeds the same named input, so compare the semantic edge. */
  const links = (value) => {
    const byId = new Map((value?.nodes ?? []).map((node) => [String(node.id), node]));
    return (value?.links ?? []).map((link) => {
      const target = byId.get(String(link[3]));
      const input = target?.inputs?.[link[4]]?.name ?? `#${link[4]}`;
      return JSON.stringify([String(link[1]), link[2], String(link[3]), input, link[5]]);
    }).sort();
  };
  return JSON.stringify(entries(actual)) === JSON.stringify(entries(expected))
    && JSON.stringify(nodes(serialized)) === JSON.stringify(nodes(workflow))
    && JSON.stringify(links(serialized)) === JSON.stringify(links(workflow));
}

/** Load twice at most because ComfyUI can finish restoring its previous tab after the first load. */
export async function loadFeatureGraph(app, workflow, name, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await app.loadGraphData(workflow, true, true, name);
    await pause(1500);
    if (loadedFeatureMatches(app.graph.serialize(), workflow)) return;
  }
  throw new Error(`The node editor did not keep “${name}” open.`);
}

export function showFeatureError(doc, message) {
  const notice = doc.createElement("div");
  notice.setAttribute("role", "alert");
  notice.textContent = `The workflow did not open. ${message}`;
  Object.assign(notice.style, { position: "fixed", inset: "16px 16px auto", zIndex: "100000", padding: "12px 16px", borderRadius: "10px", background: "#2b1717", color: "#fff" });
  doc.body.append(notice);
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
  await loadFeatureGraph(app, workflow, name);
}

if (typeof window !== "undefined") open().catch((error) => { console.warn("[ComfyField]", error.message); showFeatureError(document, error.message); });

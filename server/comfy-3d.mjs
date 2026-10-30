/** Runs only inside the isolated ComfyUI origin. Never queues or downloads. */
export const tools = Object.freeze({
  viewer: {}, image: { tasks: ["Image to 3D", "Image to Model"] },
  text: { tasks: ["Text to Model"] }, texture: { search: "texture" },
  mesh: { search: "mesh" }, workflows: {},
});
export function parseTool(search) {
  const value = new URLSearchParams(search).get("studio3d");
  return Object.hasOwn(tools, value) ? value : null;
}
function waitFor(find, timeout = 20000) {
  return new Promise((resolve, reject) => {
    let observer, timer;
    const check = () => {
      const value = find();
      if (!value) return;
      observer?.disconnect(); clearTimeout(timer); resolve(value);
    };
    observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    timer = setTimeout(() => { observer.disconnect(); reject(new Error("3D tools did not become ready.")); }, timeout);
    check();
  });
}
const visible = element => element.getClientRects().length > 0;
const exact = (root, selector, text) => [...root.querySelectorAll(selector)].find(el => visible(el) && el.textContent.trim() === text);
export function workflowReady(app) {
  const store = app?.extensionManager?.workflow;
  return !!store?.activeWorkflow && !store.isBusy && !store.isSyncLoading && !store.activeWorkflow.isLoading;
}
export function viewerFilename(openWorkflows = []) {
  const names = new Set(openWorkflows.map(workflow => workflow.path.split("/").at(-1)));
  for (let index = 1; index <= names.size + 1; index++) {
    const name = index === 1 ? "3D viewer.json" : `3D viewer ${index}.json`;
    if (!names.has(name)) return name;
  }
}
const openingViewers = new WeakMap();
const OBJ_BUFFER_ISOLATION = Symbol.for("comfyfield.obj-buffer-isolation.v1");
const OBJ_LOAD_ISOLATION = Symbol.for("comfyfield.obj-load-isolation.v1");
const isolatedAdapters = new WeakSet();
/** The parallel loader transfers its input. FileLoader can share that input
 * between the inline preview and modal, so each parser needs its own bytes. */
export function isolateObjBuffers(Adapter) {
  if (typeof Adapter !== "function") return false;
  if (isolatedAdapters.has(Adapter)) return true;
  const loader = new Adapter().objLoader, proto = loader && Object.getPrototypeOf(loader);
  if (proto?.constructor?.name !== "OBJLoader2Parallel" || typeof proto.parse !== "function" || typeof proto.initWorkerParse !== "function") return false;
  if (!Object.hasOwn(proto, OBJ_BUFFER_ISOLATION)) {
    const parse = proto.parse;
    Object.defineProperty(proto, "parse", {configurable:true,writable:true,value:function(data,...args) {
      const owned = data instanceof ArrayBuffer ? data.slice(0) : ArrayBuffer.isView(data)
        ? data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength) : data;
      return parse.call(this, owned, ...args);
    }});
    Object.defineProperty(proto, OBJ_BUFFER_ISOLATION, {value:true});
  }
  // A native adapter can receive overlapping loads. Its parser callbacks and
  // base object are mutable, so do not share that parser between requests.
  if (typeof Adapter.prototype.loadOBJ === "function" && !Object.hasOwn(Adapter.prototype, OBJ_LOAD_ISOLATION)) {
    const load = Adapter.prototype.loadOBJ;
    Object.defineProperty(Adapter.prototype,"loadOBJ",{configurable:true,writable:true,value:function(...args) {
      const request = new Adapter();
      request.objLoader.setTerminateWorkerOnLoad?.(true);
      return load.apply(request,args);
    }});
    Object.defineProperty(Adapter.prototype,OBJ_LOAD_ISOLATION,{value:true});
  }
  isolatedAdapters.add(Adapter);
  return true;
}
export function viewerWorkspace(pathname) {
  return pathname.match(/^\/comfy\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i)?.[1]?.toLowerCase() ?? null;
}
export function findViewer(store, workspaceId) {
  if (!workspaceId) return null;
  const candidates = [store.activeWorkflow, ...[...(store.openWorkflows ?? [])].reverse()];
  return candidates.find(workflow => {
    const graph = workflow?.activeState;
    return graph?.extra?.comfyfield?.viewerVersion === 1 && graph.extra.comfyfield.workspaceId === workspaceId &&
      graph.nodes?.some(node => node.type === "Load3D");
  }) ?? null;
}
const viewerDialog = () => document.querySelector('[role="dialog"][aria-labelledby="global-load3d-viewer"][data-state="open"]');
function previewOpenError() {
  const error = new Error("Close the current 3D preview before switching viewers.");
  error.code = "viewer_preview_open";
  return error;
}
async function showViewerNode(app,node) {
  const button = await waitFor(() => document.querySelector(`.lg-node[data-node-id="${node.id}"] button[aria-label="Open in 3D Viewer"]`));
  const model = node.widgets?.find(widget => widget.name === "model_file");
  if (model?.value && model.value !== "none") {
    // The open button mounts before the inline viewport. Native configuration
    // installs this setter after starting the saved model's asynchronous load.
    await waitFor(() => Object.getOwnPropertyDescriptor(model,"value")?.set &&
      document.querySelector(`.lg-node[data-node-id="${node.id}"] canvas`));
    // Let Vue commit its loading overlay before testing whether loading ended.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await waitFor(() => !document.querySelector(`.lg-node[data-node-id="${node.id}"] [data-testid="loading-overlay"]`));
  }
  // Waiting must never open a preview for a graph the user switched away from.
  if (!app.graph._nodes?.includes(node)) throw new Error("The viewer changed while its model was loading. Open it again.");
  button.click();
  const dialog = await waitFor(viewerDialog);
  dialog.dataset.comfyfieldViewerGraph = app.graph.id;
  dialog.dataset.comfyfieldViewerNode = String(node.id);
}
async function openViewer(app) {
  const store = app.extensionManager.workflow, workspaceId = viewerWorkspace(location.pathname);
  if (!workspaceId) throw new Error("Open the viewer from a ComfyField workspace.");
  await waitFor(() => window.LiteGraph?.registered_node_types?.Load3D);
  if (store.activeWorkflow?.activeState?.id && store.activeWorkflow.activeState.id !== app.graph.id)
    throw new Error("The active workflow is still changing; no viewer was opened.");
  const preview = viewerDialog();
  if (preview) {
    if (preview.dataset.comfyfieldViewerGraph === app.graph.id && app.graph._nodes?.some(node => node.type === "Load3D" && String(node.id) === preview.dataset.comfyfieldViewerNode)) {
      preview.focus();return;
    }
    // The native modal has one global key. Reopening it with a different node
    // keeps its old viewport; closing it here would discard transient settings.
    throw previewOpenError();
  }
  // Vue graph edits can precede the workflow's cached activeState.
  store.activeWorkflow?.changeTracker?.captureCanvasState?.();
  const existing = findViewer(store, workspaceId);
  if (existing) {
    // openWorkflow alone changes the tab, not the graph, in the installed frontend.
    // Load a copy of its captured graph through the native workflow lifecycle.
    if (store.activeWorkflow?.path !== existing.path)
      await app.loadGraphData(JSON.parse(JSON.stringify(existing.activeState)), true, true, existing);
    if (store.activeWorkflow?.path !== existing.path || app.graph.id !== existing.activeState?.id)
      throw new Error("The existing viewer did not become active; its graph was kept unchanged.");
    const node = app.graph._nodes?.find(node => node.type === "Load3D");
    if (!node) throw new Error("The existing viewer has no model node.");
    app.canvas.centerOnNode(node);
    await showViewerNode(app,node);
    return;
  }
  // A unique, marked workflow never borrows the user's blank-workflow id/name.
  const graph = { id: crypto.randomUUID(), revision: 0, last_node_id: 0, last_link_id: 0,
    nodes: [], links: [], groups: [], config: {}, extra: {comfyfield:{viewerVersion:1,workspaceId}}, version: 0.4 };
  const workflow = await store.createNewTemporary(viewerFilename(store.openWorkflows), graph);
  await app.loadGraphData(graph, true, true, workflow);
  if (app.graph.id !== graph.id || store.activeWorkflow?.path !== workflow.path)
    throw new Error("The viewer workflow did not become active; no node was added.");
  const node = window.LiteGraph.createNode("Load3D");
  app.graph.add(node);
  workflow.changeTracker?.captureCanvasState?.();
  app.canvas.centerOnNode(node);
  await showViewerNode(app,node);
}
export async function openTool(mode) {
  if (!Object.hasOwn(tools, mode)) return;
  const commandId = mode === "viewer" ? "Comfy.NewBlankWorkflow" : "Comfy.BrowseTemplates";
  const app = await waitFor(() => {
    if (mode === "viewer") isolateObjBuffers(window.comfyAPI?.MeshModelAdapter?.MeshModelAdapter);
    const candidate = window.comfyAPI?.app?.app;
    return candidate?.vueAppReady && workflowReady(candidate) && candidate?.graph && candidate?.canvas && document.querySelector('canvas') &&
      Object.values(candidate.extensionManager?.command?.commands ?? {}).some(command => command.id === commandId) && candidate;
  });
  if (mode === "viewer") {
    if (openingViewers.has(app)) return openingViewers.get(app);
    const pending = openViewer(app);
    openingViewers.set(app, pending);
    try { return await pending; } finally { openingViewers.delete(app); }
  }
  await app.extensionManager.command.execute("Comfy.BrowseTemplates");
  const dialog = await waitFor(() => [...document.querySelectorAll('[role="dialog"]')].find(visible));
  const category = await waitFor(() => exact(dialog, "a,button,span,div", "3D Model"));
  category.click();
  exact(dialog, "button", "Clear all filters")?.click();
  const search = await waitFor(() => dialog.querySelector('input[placeholder="Search ..."]'));
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(search, "");
  search.dispatchEvent(new Event("input", { bubbles: true }));
  const config = tools[mode];
  if (config.tasks) {
    const taskPicker = await waitFor(() => [...dialog.querySelectorAll('[aria-label="Tasks"]')].find(visible));
    taskPicker.click();
    for (const task of config.tasks) {
      const option = await waitFor(() => exact(document, '[role="option"]', task));
      option.click();
    }
    taskPicker.click();
  }
  if (config.search) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(search, config.search);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
if (typeof document !== "undefined") {
  const mode = parseTool(location.search);
  if (mode) openTool(mode).catch(error => {
    console.warn("ComfyField 3D entry:", error);
    const app = window.comfyAPI?.app?.app;
    app?.ui?.dialog?.show(error.code === "viewer_preview_open" ? error.message : "Could not open this 3D tool. Open Browse Templates and choose 3D Model, or add a Load3D node for the model viewer. Reload to try again.");
  });
}

import { HttpError } from "./auth";
import type { ObjectInfo, UiWorkflow } from "../src/workflow/ui-to-api";

/** ComfyHub and the official template repository only; anything else is refused before a request is made. */
const HUB_HOSTS = new Set(["comfy.org", "www.comfy.org", "raw.githubusercontent.com", "github.com"]);
const MAX_BYTES = 5_000_000;
const MODEL_FILE = /\.(safetensors|gguf|ckpt|pth|pt|bin|sft)$/i;

export function isHubUrl(value: string): boolean {
  return /^https:\/\//i.test(value);
}

/** Accepts a Hub download link, a raw GitHub link or a github.com blob link of the Comfy-Org organisation. */
export function normalizeHubUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(422, "Enter a full https address of a ComfyHub or Comfy-Org workflow"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new HttpError(422, "Only plain https addresses are accepted");
  if (!HUB_HOSTS.has(url.hostname)) throw new HttpError(422, "Only comfy.org and the Comfy-Org GitHub repositories are accepted");
  if (url.hostname === "github.com") {
    const match = url.pathname.match(/^\/(Comfy-Org)\/([^/]+)\/blob\/(.+)$/);
    if (!match) throw new HttpError(422, "Use a github.com/Comfy-Org/…/blob/… file link");
    return new URL(`https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`);
  }
  if (url.hostname === "raw.githubusercontent.com" && !url.pathname.startsWith("/Comfy-Org/")) throw new HttpError(422, "Only Comfy-Org repositories are accepted");
  return url;
}

/** Downloads one workflow JSON. Redirects are followed only within the allowed hosts. */
export async function fetchHubWorkflow(value: string, fetcher: typeof fetch = fetch): Promise<{ ui: UiWorkflow; raw: string; url: string }> {
  let url = normalizeHubUrl(value);
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { accept: "application/json" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new HttpError(502, "The workflow host redirected without a target");
      url = normalizeHubUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new HttpError(502, `The workflow host answered ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES) throw new HttpError(413, "The workflow file is larger than 5 MB");
    const raw = await response.text();
    if (raw.length > MAX_BYTES) throw new HttpError(413, "The workflow file is larger than 5 MB");
    return { ui: parseWorkflow(raw), raw, url: url.toString() };
  }
  throw new HttpError(502, "Too many redirects from the workflow host");
}

export function parseWorkflow(raw: string): UiWorkflow {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new HttpError(422, "The file is not valid JSON"); }
  if (!value || typeof value !== "object" || !Array.isArray((value as { nodes?: unknown }).nodes)) throw new HttpError(422, "This is not a ComfyUI workflow (no nodes list). Export it from ComfyUI as a workflow file");
  return value as UiWorkflow;
}

export type HubReadiness = {
  nodes: number;
  missingNodes: Array<{ class: string; count: number }>;
  models: Array<{ name: string; present: boolean; url?: string }>;
  state: "ready" | "partial" | "missing";
};

type UiNode = { type?: string; widgets_values?: unknown; properties?: { models?: Array<{ name?: string; url?: string }> } };

function allNodes(ui: UiWorkflow): UiNode[] {
  const top = (ui as { nodes?: UiNode[] }).nodes ?? [];
  const subgraphs = ((ui as { definitions?: { subgraphs?: Array<{ nodes?: UiNode[] }> } }).definitions?.subgraphs ?? []).flatMap((graph) => graph.nodes ?? []);
  return [...top, ...subgraphs];
}

/** What this worker would still need: node classes it lacks and model files it does not list. Nothing is downloaded. */
export function hubReadiness(ui: UiWorkflow, objectInfo: ObjectInfo): HubReadiness {
  const nodes = allNodes(ui);
  const subgraphIds = new Set(((ui as { definitions?: { subgraphs?: Array<{ id?: string }> } }).definitions?.subgraphs ?? []).map((graph) => graph.id).filter(Boolean) as string[]);
  const missing = new Map<string, number>();
  for (const node of nodes) {
    const type = node.type ?? "";
    if (!type || type in objectInfo || subgraphIds.has(type) || ["Note", "MarkdownNote", "PrimitiveNode", "Reroute"].includes(type)) continue;
    missing.set(type, (missing.get(type) ?? 0) + 1);
  }
  const choices = new Set<string>();
  for (const info of Object.values(objectInfo) as Array<{ input?: Record<string, Record<string, unknown>> }>) {
    for (const group of Object.values(info.input ?? {})) for (const spec of Object.values(group ?? {})) {
      const options = Array.isArray(spec) ? spec[0] : undefined;
      if (Array.isArray(options)) for (const option of options) if (typeof option === "string") choices.add(option.replace(/\\/g, "/"));
    }
  }
  const present = (name: string) => [...choices].some((choice) => choice === name || choice.endsWith(`/${name}`));
  const models = new Map<string, { name: string; present: boolean; url?: string }>();
  for (const node of nodes) {
    for (const model of node.properties?.models ?? []) if (model.name) models.set(model.name, { name: model.name, present: present(model.name), url: model.url });
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    for (const value of values) if (typeof value === "string" && MODEL_FILE.test(value)) {
      const name = value.replace(/\\/g, "/").split("/").pop()!;
      if (!models.has(name)) models.set(name, { name, present: present(name) });
    }
  }
  const missingNodes = [...missing].map(([cls, count]) => ({ class: cls, count }));
  const modelList = [...models.values()];
  const state = !missingNodes.length && modelList.every((m) => m.present) ? "ready" : !missingNodes.length ? "partial" : "missing";
  return { nodes: nodes.length, missingNodes, models: modelList, state };
}

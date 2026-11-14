// Builds a ComfyUI editor workflow (UI format) from an API graph, the inverse of ui-to-api.ts, so a ComfyField feature
// can be opened in the official editor with every link in place. The rules mirror uiToApi exactly:
//   - widgets_values holds one value per widget input in input_order; a linked widget keeps its slot
//   - INT inputs with control_after_generate and upload inputs add one extra value
//   - dynamic dropdown children ("parent.child") follow their parent's value
// Node ids become 1..n (the editor only wires numeric ids); the original ids are kept in extra.comfyfield.ids.

import type { ApiGraph } from "./build";
import type { ObjectInfo } from "./ui-to-api";

const DYNAMIC_COMBO = "COMFY_DYNAMICCOMBO_V3";
const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "COLOR", DYNAMIC_COMBO]);
type InputSpec = [string | string[], Record<string, unknown>?];
type Info = ObjectInfo[string] & { output?: string[]; output_name?: string[] };

export type UiSocket = { name: string; type: string; link: number | null; widget?: { name: string } };
export type UiOutput = { name: string; type: string; links: number[] };
export type EditorNode = {
  id: number; type: string; title?: string; pos: [number, number]; size: [number, number]; flags: Record<string, never>;
  order: number; mode: 0; inputs: UiSocket[]; outputs: UiOutput[]; properties: Record<string, string>; widgets_values: unknown[];
};
export type EditorWorkflow = {
  last_node_id: number; last_link_id: number; nodes: EditorNode[];
  links: Array<[number, number, number, number, number, string]>;
  groups: []; config: Record<string, never>; extra: { comfyfield: { ids: Record<string, string> } }; version: number;
};

const isLink = (value: unknown): value is [string, number] => Array.isArray(value) && value.length === 2 && (typeof value[0] === "string" || typeof value[0] === "number") && typeof value[1] === "number";
/** The extra saved values the editor keeps after some widgets: the seed control and the upload button. */
const extraValues = (cfg: Record<string, unknown>): unknown[] => [
  ...(cfg.control_after_generate ? ["fixed"] : []),
  ...(cfg.image_upload ? ["image"] : cfg.video_upload ? ["video"] : cfg.audio_upload ? ["audio"] : []),
];

/** The value the editor shows for a widget nobody set: its default, else the first choice of a dropdown. */
function defaultOf([type, cfg = {}]: InputSpec): unknown {
  if (cfg.default !== undefined) return cfg.default;
  if (Array.isArray(type)) return type[0] ?? null;
  const option = (cfg.options as unknown[] | undefined)?.[0];
  return option && typeof option === "object" ? (option as { key?: unknown }).key ?? null : option ?? null;
}

/** forceInput values have no widget in the editor, so a fixed value travels on a core primitive node. */
const PRIMITIVE: Record<string, string> = { STRING: "PrimitiveStringMultiline", INT: "PrimitiveInt", FLOAT: "PrimitiveFloat", BOOLEAN: "PrimitiveBoolean" };
/** Marks a primitive that apiToUi added; restoreFeatureIds folds its value back into the field. */
export const INLINE_PREFIX = "~inline:";

export function apiToUi(graph: ApiGraph, info: ObjectInfo): EditorWorkflow {
  graph = withPrimitives(graph, info);
  const keys = Object.keys(graph), toId = new Map(keys.map((key, index) => [key, index + 1]));
  const ids: Record<string, string> = Object.fromEntries(keys.map((key, index) => [String(index + 1), key]));
  const links: EditorWorkflow["links"] = [];
  const outputs = new Map<number, UiOutput[]>();
  const outputType = (key: string, slot: number) => ((info[graph[key]?.class_type] as Info | undefined)?.output?.[slot]) ?? "*";

  // Outputs first, so links can be registered against them.
  for (const key of keys) {
    const spec = info[graph[key].class_type] as Info | undefined;
    if (!spec) throw new Error(`Node ${key}: class "${graph[key].class_type}" is not installed on this server`);
    outputs.set(toId.get(key)!, (spec.output ?? []).map((type, slot) => ({ name: spec.output_name?.[slot] ?? type, type, links: [] })));
  }
  let linkId = 0;
  const connect = (value: [string, number], target: number, targetSlot: number) => {
    const source = toId.get(String(value[0]));
    if (!source) throw new Error(`A node points at node ${value[0]}, which does not exist`);
    const id = ++linkId, type = outputType(String(value[0]), value[1]);
    links.push([id, source, value[1], target, targetSlot, type]);
    outputs.get(source)?.[value[1]]?.links.push(id);
    return id;
  };

  const nodes: EditorNode[] = keys.map((key, index) => {
    const node = graph[key], id = toId.get(key)!, spec = info[node.class_type] as Info;
    const order = [...(spec.input_order?.required ?? Object.keys(spec.input.required ?? {})), ...(spec.input_order?.optional ?? Object.keys(spec.input.optional ?? {}))];
    const defs = { ...(spec.input.optional ?? {}), ...(spec.input.required ?? {}) } as Record<string, InputSpec>;
    const given = (node.inputs ?? {}) as Record<string, unknown>;
    const inputs: UiSocket[] = [], values: unknown[] = [];
    const socket = (name: string, type: string, value: unknown, widget: boolean) => {
      const entry: UiSocket = { name, type, link: null, ...(widget ? { widget: { name } } : {}) };
      inputs.push(entry);
      if (isLink(value)) entry.link = connect(value, id, inputs.length - 1);
    };
    const widget = (name: string, def: InputSpec) => {
      const [type, cfg = {}] = def;
      // A graph saved against an older schema may hold a dropdown child under its plain name ("codec" for "format.codec").
      const legacy = name.includes(".") ? given[name.slice(name.indexOf(".") + 1)] : undefined;
      const value = given[name] !== undefined ? given[name] : legacy !== undefined && !isLink(legacy) ? legacy : undefined;
      if (isLink(value)) { socket(name, Array.isArray(type) ? "COMBO" : type, value, true); values.push(cfg.default ?? null); }
      else values.push(value === undefined ? defaultOf(def) : value);
      values.push(...extraValues(cfg));
      if (type === DYNAMIC_COMBO) {
        type Option = { key: string; inputs?: { required?: Record<string, InputSpec>; optional?: Record<string, InputSpec> } };
        const option = ((cfg.options as Option[] | undefined) ?? []).find((o) => o.key === value);
        for (const [child, childDef] of [...Object.entries(option?.inputs?.required ?? {}), ...Object.entries(option?.inputs?.optional ?? {})]) {
          const full = `${name}.${child}`, childType = childDef[0], childIsWidget = Array.isArray(childType) || WIDGET_TYPES.has(childType);
          if (childIsWidget) widget(full, childDef);
          else socket(full, String(childType), given[full], false);
        }
      }
    };
    for (const name of order) {
      const def = defs[name];
      if (!def) continue;
      const [type, cfg = {}] = def, isWidget = (Array.isArray(type) || WIDGET_TYPES.has(type) || !!cfg.socketless) && !cfg.forceInput;
      if (cfg.hidden && given[name] === undefined) continue;
      if (String(type).startsWith("COMFY_AUTOGROW")) continue;
      if (isWidget) widget(name, def);
      else socket(name, String(type), given[name], false);
    }
    // Run-time inputs ("values.a" on a math node) exist only as links.
    for (const [name, value] of Object.entries(given)) if (!(name in defs) && !inputs.some((i) => i.name === name) && isLink(value)) socket(name, outputType(String(value[0]), value[1]), value, false);
    const title = (node as { _meta?: { title?: string } })._meta?.title;
    return { id, type: node.class_type, ...(title && title !== node.class_type ? { title } : {}), pos: [0, 0], size: [320, 140], flags: {}, order: index, mode: 0, inputs, outputs: outputs.get(id)!, properties: { "Node name for S&R": node.class_type }, widgets_values: values };
  });

  // Left-to-right by depth from the sources, so the graph reads in the order it runs.
  const depth = new Map<number, number>(), incoming = new Map<number, number[]>();
  for (const [, source, , target] of links) incoming.set(target, [...(incoming.get(target) ?? []), source]);
  const depthOf = (id: number, seen = new Set<number>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const value = Math.max(-1, ...(incoming.get(id) ?? []).map((source) => depthOf(source, seen))) + 1;
    depth.set(id, value);
    return value;
  };
  const rows = new Map<number, number>();
  for (const node of nodes) {
    const column = depthOf(node.id), row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    node.pos = [column * 380, row * 220];
  }
  return { last_node_id: nodes.length, last_link_id: linkId, nodes, links, groups: [], config: {}, extra: { comfyfield: { ids } }, version: 0.4 };
}

/** Gives every literal value of a forceInput field its own primitive node, linked into that field. */
function withPrimitives(graph: ApiGraph, info: ObjectInfo): ApiGraph {
  const out: ApiGraph = { ...graph };
  for (const [key, node] of Object.entries(graph)) {
    const spec = info[node.class_type];
    if (!spec) continue;
    const defs = { ...(spec.input.optional ?? {}), ...(spec.input.required ?? {}) } as Record<string, InputSpec>;
    const inputs = { ...(node.inputs as Record<string, unknown>) };
    let changed = false;
    for (const [name, value] of Object.entries(inputs)) {
      const def = defs[name], primitive = def && def[1]?.forceInput ? PRIMITIVE[String(def[0])] : undefined;
      if (!primitive || value === undefined || isLink(value) || !info[primitive]) continue;
      const id = `${INLINE_PREFIX}${key}:${name}`;
      out[id] = { class_type: primitive, inputs: { value }, _meta: { title: name } } as ApiGraph[string];
      inputs[name] = [id, 0];
      changed = true;
    }
    if (changed) out[key] = { ...node, inputs } as ApiGraph[string];
  }
  return out;
}

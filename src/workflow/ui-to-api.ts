// Converts a ComfyUI workflow saved in the UI format (nodes + links + widgets_values)
// into the API format that /prompt accepts. ComfyUI's own template browser ships UI-format
// files; this lets a template become a provider without opening the ComfyUI editor.
//
// The mapping rules come from how the UI stores widgets:
//   - widgets_values lists one value per widget input, in the node's input_order
//   - a widget that was converted to a link keeps its slot in widgets_values
//   - INT inputs with control_after_generate add one extra value ("randomize")
//   - image/video/audio upload inputs add one extra value (the upload button)
//
// Subgraphs are flattened the way the ComfyUI editor does it when it exports an API workflow:
// a subgraph instance disappears, its inner nodes become ordinary nodes with IDs like "129:98"
// (instance 129, inner node 98), and the instance's inputs and outputs are wired straight through.

import type { ApiGraph } from "./build";

export type UiNode = {
  id: number;
  type: string;
  title?: string;
  mode?: number; // 0 normal, 2 muted, 4 bypassed
  inputs?: Array<{ name: string; link?: number | null }>;
  widgets_values?: unknown;
};

export type UiWorkflow = {
  nodes: UiNode[];
  // [linkId, sourceNodeId, sourceSlot, targetNodeId, targetSlot, type]
  links: Array<[number, number, number, number, number, string]>;
  definitions?: { subgraphs?: UiSubgraph[] };
};

type SubLink = { id: number; origin_id: number; origin_slot: number; target_id: number; target_slot: number };

export type UiSubgraph = {
  id: string;
  inputs: Array<{ name: string; type: string }>;
  outputs: Array<{ name: string }>;
  nodes: UiNode[];
  links: SubLink[];
};

type InputSpec = [string | string[], Record<string, unknown>?];
export type ObjectInfo = Record<
  string,
  {
    input: { required?: Record<string, InputSpec>; optional?: Record<string, InputSpec> };
    input_order?: { required?: string[]; optional?: string[] };
    output_node?: boolean;
  }
>;

export type ConvertOptions = {
  /**
   * Nodes that are bypassed in the template but should run (for example an optional image loader).
   * A number is a top-level node ID; a string is a flattened key such as "129:98".
   */
  enable?: Array<number | string>;
};

// Notes exist only in the editor.
const EDITOR_ONLY = new Set(["MarkdownNote", "Note"]);
const DYNAMIC_COMBO = "COMFY_DYNAMICCOMBO_V3";
const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "COLOR", DYNAMIC_COMBO]);

/** What an input stands for after flattening: another node's output, or a fixed value. */
type Source = { key: string; slot: number };
type Constant = { value: unknown };
type Resolved = Source | Constant | undefined;

/** One level of the workflow: the top level, or the inside of one subgraph instance. */
type Scope = {
  prefix: string; // "" at the top, "129:" inside instance 129
  nodes: UiNode[];
  links: Map<number, SubLink>;
  /** Inside a subgraph: what each of the subgraph's inputs stands for. */
  bound?: Resolved[];
  /** Subgraph instances in this scope that have been expanded, with what each output stands for. */
  expanded: Map<number, Resolved[]>;
};

export function uiToApi(ui: UiWorkflow, info: ObjectInfo, opts: ConvertOptions = {}): ApiGraph {
  const subgraphs = new Map((ui.definitions?.subgraphs ?? []).map((s) => [s.id, s]));
  const enable = new Set((opts.enable ?? []).map(String));
  const included = new Map<string, { scope: Scope; node: UiNode }>();

  const topScope: Scope = {
    prefix: "",
    nodes: ui.nodes,
    links: new Map(ui.links.map(([id, o, os, t, ts]) => [id, { id, origin_id: o, origin_slot: os, target_id: t, target_slot: ts }])),
    expanded: new Map(),
  };

  const isSkipped = (node: UiNode, key: string) =>
    EDITOR_ONLY.has(node.type) || node.type === "Reroute" || node.mode === 2 || (node.mode === 4 && !enable.has(key));

  /** Follows a link back to what feeds it, going through subgraph boundaries. */
  function resolveLink(scope: Scope, linkId: number, hops = 0): Resolved {
    if (hops > 64) throw new Error("Reroute nodes loop back on themselves");
    const link = scope.links.get(linkId);
    if (!link) throw new Error(`A node points at link ${linkId}, which does not exist`);
    if (link.origin_id === -10) return scope.bound?.[link.origin_slot]; // the subgraph's input node
    const origin = scope.nodes.find((n) => n.id === link.origin_id);
    if (origin && subgraphs.has(origin.type)) return expandInstance(scope, origin)[link.origin_slot];
    // A Reroute only bends a wire in the editor: the input is whatever feeds it.
    if (origin?.type === "Reroute") {
      const feed = origin.inputs?.find((input) => input.link != null);
      return feed ? resolveLink(scope, feed.link as number, hops + 1) : undefined;
    }
    return { key: `${scope.prefix}${link.origin_id}`, slot: link.origin_slot };
  }

  /** Expands one subgraph instance (once) and returns what each of its outputs stands for. */
  function expandInstance(scope: Scope, instance: UiNode): Resolved[] {
    const done = scope.expanded.get(instance.id);
    if (done) return done;

    const sub = subgraphs.get(instance.type)!;
    const values = Array.isArray(instance.widgets_values) ? instance.widgets_values : [];
    let cursor = 0;

    // What each subgraph input stands for: a link from outside, or the instance's own widget value.
    const bound: Resolved[] = sub.inputs.map((input) => {
      const isWidget = WIDGET_TYPES.has(input.type);
      const widgetValue = isWidget && cursor < values.length ? { value: values[cursor++] } : undefined;
      const outside = instance.inputs?.find((i) => i.name === input.name && i.link != null);
      return outside ? resolveLink(scope, outside.link as number) : widgetValue;
    });

    const inner: Scope = {
      prefix: `${scope.prefix}${instance.id}:`,
      nodes: sub.nodes,
      links: new Map(sub.links.map((l) => [l.id, l])),
      bound,
      expanded: new Map(),
    };
    // Reserve the slot first so a (malformed) cycle cannot recurse forever.
    scope.expanded.set(instance.id, []);
    collect(inner);

    const outputs = sub.outputs.map((_, slot) => {
      const link = sub.links.find((l) => l.target_id === -20 && l.target_slot === slot); // the subgraph's output node
      return link ? resolveLink(inner, link.id) : undefined;
    });
    scope.expanded.set(instance.id, outputs);
    return outputs;
  }

  /** Registers the ordinary nodes of a scope and expands the subgraph instances inside it. */
  function collect(scope: Scope) {
    const connected = new Set<number>();
    for (const link of scope.links.values()) {
      connected.add(link.origin_id);
      connected.add(link.target_id);
    }
    for (const node of scope.nodes) {
      const key = `${scope.prefix}${node.id}`;
      if (isSkipped(node, key)) continue;
      // Templates can contain unused scratch nodes, including inside subgraphs.
      // Only discard a proven non-output with no links in either representation.
      // Unknown schemas, output nodes, explicit enables and broken links still validate.
      if (info[node.type]?.output_node === false && !connected.has(node.id)
        && !node.inputs?.some((input) => input.link != null) && !enable.has(key)) continue;
      if (subgraphs.has(node.type)) expandInstance(scope, node);
      else if (node.type === "PrimitiveNode") {
        throw new Error(`Node ${key} (${node.type}) is editor-only and not supported by the converter`);
      } else included.set(key, { scope, node });
    }
  }
  collect(topScope);

  const graph: ApiGraph = {};
  for (const [key, { scope, node }] of included) {
    const spec = info[node.type];
    if (!spec) throw new Error(`Node ${key}: class "${node.type}" is not installed on this server`);

    const order = [...(spec.input_order?.required ?? []), ...(spec.input_order?.optional ?? [])];
    const defs = { ...(spec.input.optional ?? {}), ...(spec.input.required ?? {}) };
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    const inputs: Record<string, unknown> = {};
    let cursor = 0;

    /** Writes a resolved input; false when it leads nowhere usable. */
    const assign = (name: string, source: Resolved, required: boolean): void => {
      if (!source || ("value" in source && source.value === undefined)) {
        if (required) throw new Error(`Node ${key} (${node.type}): required input "${name}" is not connected`);
        return;
      }
      if ("value" in source) {
        inputs[name] = source.value;
        return;
      }
      if (!included.has(source.key)) {
        // An optional input fed by a bypassed node simply goes unconnected
        // (the template's text-to-video mode). A required one cannot run.
        if (required) throw new Error(`Node ${key}: input "${name}" is fed by node ${source.key}, which is muted or bypassed`);
        return;
      }
      inputs[name] = [source.key, source.slot];
    };

    /**
     * A dynamic dropdown ("resize_type" on a resize node, "format" on SaveVideo) adds inputs that
     * depend on the option chosen. Their saved values follow the dropdown's own value in
     * widgets_values, and the API names them "<dropdown>.<input>".
     */
    const readChildren = (parent: string, def: InputSpec, selected: unknown): void => {
      type Option = { key: string; inputs?: { required?: Record<string, InputSpec>; optional?: Record<string, InputSpec> } };
      const option = ((def[1]?.options as Option[] | undefined) ?? []).find((o) => o.key === selected);
      if (!option) return;
      const children = [...Object.entries(option.inputs?.required ?? {}), ...Object.entries(option.inputs?.optional ?? {})];
      for (const [child, childDef] of children) {
        const full = `${parent}.${child}`;
        const childType = childDef[0];
        const childCfg = childDef[1] ?? {};
        const childIsWidget = Array.isArray(childType) || WIDGET_TYPES.has(childType);
        const linked = node.inputs?.find((i) => i.name === full && i.link != null);
        if (linked) {
          assign(full, resolveLink(scope, linked.link as number), false);
          if (childIsWidget) cursor += 1 + extraSlots(childCfg); // a linked widget keeps its saved slot
        } else if (childIsWidget && cursor < values.length) {
          inputs[full] = values[cursor];
          cursor += 1 + extraSlots(childCfg);
          if (childType === DYNAMIC_COMBO) readChildren(full, childDef, inputs[full]);
        }
      }
    };

    for (const name of order) {
      const def = defs[name];
      if (!def) continue;
      const type = def[0];
      const cfg = def[1] ?? {};
      const isWidget = (Array.isArray(type) || WIDGET_TYPES.has(type) || !!cfg.socketless) && !cfg.forceInput;
      const required = name in (spec.input.required ?? {});
      const slot = node.inputs?.find((i) => i.name === name && i.link != null);

      if (slot) {
        const source = resolveLink(scope, slot.link as number);
        // Current templates may proxy a subgraph widget without duplicating its
        // saved value on the instance. Its inner widget still holds the default.
        if (!source && isWidget && cursor < values.length) inputs[name] = values[cursor];
        else assign(name, source, required);
        if (isWidget) cursor += 1 + extraSlots(cfg);
        if (type === DYNAMIC_COMBO) readChildren(name, def, inputs[name]);
      } else if (isWidget) {
        if (cursor >= values.length) {
          // A template saved before the node gained this input has no value for it.
          // Optional inputs then fall back to the server's default.
          if (!required) continue;
          throw new Error(`Node ${key} (${node.type}): no saved value for "${name}"`);
        }
        inputs[name] = values[cursor];
        cursor += 1 + extraSlots(cfg);
        if (type === DYNAMIC_COMBO) readChildren(name, def, inputs[name]);
      } else if (required && !String(type).startsWith("COMFY_AUTOGROW")) {
        // A run-time input group ("values" on a math node) is wired as "values.a", "values.b", ...
        // and handled below, so the group itself needs no connection.
        if (node.inputs?.some((i) => i.name.startsWith(`${name}.`))) continue;
        throw new Error(`Node ${key} (${node.type}): required input "${name}" is not connected`);
      }
    }

    // Inputs the node defines at run time (for example "values.a" on a math node) are not in
    // its static definition. They only exist as links, so they are carried over by name.
    for (const slot of node.inputs ?? []) {
      if (slot.link == null || slot.name in inputs || slot.name in defs) continue;
      assign(slot.name, resolveLink(scope, slot.link), false);
    }

    graph[key] = {
      class_type: node.type,
      inputs,
      // The editor shows this as the node title; it is ignored when running.
      _meta: { title: node.title ?? node.type },
    } as ApiGraph[string];
  }

  return graph;
}

function extraSlots(cfg: Record<string, unknown>): number {
  let n = 0;
  if (cfg.control_after_generate) n += 1;
  if (cfg.image_upload || cfg.video_upload || cfg.audio_upload) n += 1;
  return n;
}

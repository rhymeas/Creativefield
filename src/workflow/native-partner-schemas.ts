import type {ApiGraph} from "./build";

// Explicitly reviewed ComfyUI schema modules for the native cloud templates.
const MODULE_BY_NODE:Record<string,string>={
  KlingOmniProEditVideoNode:"nodes_kling.py",
  ByteDance2ReferenceNodeV2:"nodes_bytedance.py",
};

export function nativePartnerSchemas(graph:ApiGraph):string[]{
  return [...new Set(Object.values(graph).flatMap(node=>MODULE_BY_NODE[node.class_type]?[MODULE_BY_NODE[node.class_type]]:[]))];
}

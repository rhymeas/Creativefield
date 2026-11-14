/** ComfyUI may accept a graph while ignoring one or more invalid outputs. */
export function nativeValidationStatus(valid: boolean, errors: unknown): "ok" | "partial" | "FAIL" {
  if (!valid) return "FAIL";
  if (!errors || typeof errors !== "object" || Array.isArray(errors)) return "partial";
  return Object.keys(errors).length ? "partial" : "ok";
}

/** Exit successfully only when the whole configured catalogue was checked. */
export function nativeValidationExit(options:{statuses:Array<"ok"|"partial"|"FAIL">;skipped:number;nodeImportFailures:number;filtered:boolean;coreOnly:boolean;revisionPinned:boolean;strictNodes:boolean;validatorExit:number|null}):0|1|2 {
  if (options.statuses.includes("FAIL")) return 1;
  if (!options.statuses.length || options.statuses.includes("partial") || options.skipped || options.nodeImportFailures || options.filtered || options.coreOnly || !options.revisionPinned || !options.strictNodes || options.validatorExit!==0) return 2;
  return 0;
}

/** Human-readable reasons returned by ComfyUI's prompt validator. */
export function nativeValidationReasons(errors: unknown): string[] {
  if (!errors || typeof errors !== "object" || Array.isArray(errors)) return [];
  const reasons: string[] = [];
  for (const [id, value] of Object.entries(errors)) {
    if (!value || typeof value !== "object") continue;
    const node = value as {class_type?: unknown; errors?: unknown};
    if (!Array.isArray(node.errors)) continue;
    for (const reason of node.errors) {
      if (!reason || typeof reason !== "object") continue;
      const {message, details, type, extra_info} = reason as {message?: unknown; details?: unknown; type?: unknown; extra_info?: unknown};
      const parts = [message, details].filter((part): part is string => typeof part === "string" && !!part.trim());
      const described=parts.length>0;
      if (!described && typeof type === "string" && type.trim()) parts.push(type);
      if (!described && extra_info && typeof extra_info === "object" && !Array.isArray(extra_info)) {
        const info=extra_info as {input_name?:unknown; input_type?:unknown};
        if(typeof info.input_name === "string" && info.input_name.trim()) parts.push(`Invalid input: ${info.input_name}`);
      }
      const text = parts.join(": ");
      if (text) reasons.push(`${typeof node.class_type === "string" ? node.class_type : "Node"} #${id}: ${text}`);
    }
  }
  return reasons;
}

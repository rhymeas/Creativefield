import type {CapabilityManifestV2} from "./types";

/** The image-conditioned sibling used when a text shot has an approved still. */
export function storyboardImageSibling(id: string): string | undefined {
  if (id === "hyperflow-h3-flash-t2v") return "hyperflow-h3-flash-i2v";
  if (id === "h3-t2v") return "h3-i2v";
  return id.endsWith("-t2v") ? id.slice(0, -4) : undefined;
}

/** Drop controls specific to the text graph when using an approved still. */
export function storyboardImageControls(controls: Record<string, string | number | boolean>, source: CapabilityManifestV2, target: CapabilityManifestV2) {
  if (source.id === target.id) return controls;
  const supported = new Set(target.controls.map(control => control.id));
  const previous = new Set(source.controls.map(control => control.id));
  return Object.fromEntries(Object.entries(controls).filter(([id]) => supported.has(id) || !previous.has(id)));
}

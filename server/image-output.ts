import type { HistoryEntry, OutputFile } from "../src/comfy/client";

export const IMAGE_OUTPUT_CLASSES = new Set(["SaveImageAdvanced", "SaveImage"]);

function nodeOrder([left]: [string, unknown], [right]: [string, unknown]): number {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

function outputFile(value: unknown): OutputFile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.filename !== "string" || typeof candidate.subfolder !== "string" || typeof candidate.type !== "string") return undefined;
  return { filename: candidate.filename, subfolder: candidate.subfolder, type: candidate.type };
}

/** Files declared by approved image output nodes, in deterministic node and batch order. */
export function imageOutputFiles(graph: Record<string, { class_type: string }>, entry: HistoryEntry): OutputFile[] {
  const files: OutputFile[] = [];
  for (const [id, node] of Object.entries(graph).sort(nodeOrder)) {
    if (!IMAGE_OUTPUT_CLASSES.has(node.class_type)) continue;
    const images = entry.outputs[id]?.images;
    if (!Array.isArray(images)) continue;
    for (const value of images) {
      const file = outputFile(value);
      if (file) files.push(file);
    }
  }
  return files;
}

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function safeSegment(segment: string): boolean {
  return segment.length > 0
    && segment !== "."
    && segment !== ".."
    && !WINDOWS_DEVICE.test(segment)
    && !/[\u0000-\u001f\u007f<>:"|?*%]/.test(segment)
    && !/[. ]$/.test(segment);
}

/** Worker paths are untrusted: only relative output paths made from ordinary safe segments are accepted. */
export function assertSafeImageFile(file: OutputFile): void {
  if (!file || typeof file !== "object" || file.type !== "output" || typeof file.filename !== "string" || typeof file.subfolder !== "string") {
    throw new Error("Invalid worker output path");
  }
  if (file.filename.includes("/") || file.filename.includes("\\") || !safeSegment(file.filename)) throw new Error("Invalid worker output path");
  if (file.subfolder === "") return;
  if (file.subfolder.startsWith("/") || file.subfolder.startsWith("\\") || file.subfolder.endsWith("/") || file.subfolder.endsWith("\\")) {
    throw new Error("Invalid worker output path");
  }
  const segments = file.subfolder.split(/[\\/]/);
  if (!segments.every(safeSegment)) throw new Error("Invalid worker output path");
}

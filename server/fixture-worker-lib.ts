/* Pure parts of the fixture worker: which outputs a graph would write, a tiny valid GLB, and multipart parsing.
   The fixture worker stands in for ComfyUI while developing features, so no model has to load. */

export type FixtureMedia = "image" | "video" | "audio" | "model3d";
export type FixtureOutput = { node: string; media: FixtureMedia; key: string };
type Graph = Record<string, { class_type: string; inputs?: Record<string, unknown> }>;

/** Output nodes ComfyField ingests, with the history key ComfyUI uses for each. */
const OUTPUT_NODES: Array<[RegExp, FixtureMedia, string]> = [
  [/^SaveImage(Advanced)?$/, "image", "images"],
  [/^SaveVideo$/, "video", "images"],
  [/^SaveGLB$/, "model3d", "3d"],
  [/^SaveAudio/, "audio", "audio"],
];

export function fixtureOutputs(graph: Graph): FixtureOutput[] {
  const out: FixtureOutput[] = [];
  for (const [node, value] of Object.entries(graph)) {
    const hit = OUTPUT_NODES.find(([pattern]) => pattern.test(value.class_type));
    if (hit) out.push({ node, media: hit[1], key: hit[2] });
  }
  return out;
}

/** The first image the graph loads, so edits come back looking like their source. */
export function loadedImage(graph: Graph): string | undefined {
  for (const node of Object.values(graph)) {
    const image = node.inputs?.image;
    if (/^LoadImage/.test(node.class_type) && typeof image === "string") return image;
  }
  return undefined;
}

/** Width and height from the first node that sets both as plain numbers, rounded to even for video. */
export function graphSize(graph: Graph, fallback = 1024): { width: number; height: number } {
  for (const node of Object.values(graph)) {
    const w = node.inputs?.width, h = node.inputs?.height;
    if (typeof w === "number" && typeof h === "number" && w >= 64 && h >= 64 && w <= 4096 && h <= 4096) return { width: w & ~1, height: h & ~1 };
  }
  return { width: fallback, height: fallback };
}

/** A number input's value, following links through primitive nodes and simple math expressions (Wan computes frames as floor(seconds * fps + 1)). */
export function resolveNumber(graph: Graph, value: unknown, depth = 0): number | undefined {
  if (typeof value === "number") return value;
  if (!Array.isArray(value) || typeof value[0] !== "string" || depth > 8) return undefined;
  const node = graph[value[0]];
  if (!node) return undefined;
  if (/^Primitive(Int|Float)$/.test(node.class_type)) return resolveNumber(graph, node.inputs?.value, depth + 1);
  if (node.class_type === "ComfyMathExpression" && typeof node.inputs?.expression === "string") {
    let expression = node.inputs.expression;
    for (const [key, input] of Object.entries(node.inputs)) {
      const name = /^values\.([a-z])$/.exec(key)?.[1], number = name ? resolveNumber(graph, input, depth + 1) : undefined;
      if (name && number !== undefined) expression = expression.replace(new RegExp(`\\b${name}\\b`, "g"), String(number));
    }
    // Only digits, operators and a few rounding functions are evaluated; anything else is left unresolved.
    if (!/^(?:[\d\s.+\-*/(),]|floor|ceil|round|min|max)*$/.test(expression)) return undefined;
    const result = Function("floor", "ceil", "round", "min", "max", `return (${expression});`)(Math.floor, Math.ceil, Math.round, Math.min, Math.max);
    return typeof result === "number" && Number.isFinite(result) ? result : undefined;
  }
  return undefined;
}

/** Clip length the graph asks for: its frame count over its frame rate (for example Wan's length 81 at 16 fps). */
export function graphTiming(graph: Graph): { frames: number; fps: number; seconds: number } {
  const number = (keys: string[]) => {
    for (const node of Object.values(graph)) for (const key of keys) { const v = resolveNumber(graph, node.inputs?.[key]); if (v !== undefined && v > 0) return v; }
    return undefined;
  };
  const fps = Math.min(60, number(["fps", "frame_rate"]) ?? 24), frames = number(["length", "num_frames", "frame_count", "video_frames"]) ?? Math.round(fps * 2);
  return { frames, fps, seconds: Math.min(30, Math.max(0.5, frames / fps)) };
}

/** Prompt markers that steer the fixture: "fixture:fail" ends in an error, "fixture:slow" runs 30 s (for cancel tests). */
export function fixtureMode(graph: Graph): "fail" | "slow" | "normal" {
  const text = JSON.stringify(graph);
  return text.includes("fixture:fail") ? "fail" : text.includes("fixture:slow") ? "slow" : "normal";
}

/** A one-mesh glTF 2 binary: a 1-unit cube in a single base color. */
export function cubeGlb(rgba: [number, number, number, number] = [0.2, 0.55, 0.6, 1]): Buffer {
  const faces: Array<[number[], number[][]]> = [
    [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
    [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
    [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
    [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
    [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
  ];
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  faces.forEach(([normal, corners], f) => {
    for (const c of corners) { positions.push(...c.map((v) => v * 0.5)); normals.push(...normal); }
    const b = f * 4; indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const pos = Buffer.from(new Float32Array(positions).buffer), nor = Buffer.from(new Float32Array(normals).buffer), idx = Buffer.from(new Uint16Array(indices).buffer);
  const bin = pad(Buffer.concat([pos, nor, idx]), 0);
  const json = {
    asset: { version: "2.0", generator: "ComfyField fixture worker" },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: rgba, metallicFactor: 0, roughnessFactor: 0.6 } }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.length, target: 34962 },
      { buffer: 0, byteOffset: pos.length, byteLength: nor.length, target: 34962 },
      { buffer: 0, byteOffset: pos.length + nor.length, byteLength: idx.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: "VEC3", min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 36, type: "SCALAR" },
    ],
  };
  const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const header = Buffer.alloc(12), jsonHead = Buffer.alloc(8), binHead = Buffer.alloc(8);
  const total = 12 + 8 + jsonChunk.length + 8 + bin.length;
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
  jsonHead.writeUInt32LE(jsonChunk.length, 0); jsonHead.writeUInt32LE(0x4e4f534a, 4);
  binHead.writeUInt32LE(bin.length, 0); binHead.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHead, jsonChunk, binHead, bin]);
}

function pad(buffer: Buffer, fill: number): Buffer {
  const rest = (4 - (buffer.length % 4)) % 4;
  return rest ? Buffer.concat([buffer, Buffer.alloc(rest, fill)]) : buffer;
}

/** Parts of a multipart/form-data body: field name, optional filename, raw bytes. */
export function parseMultipart(body: Buffer, contentType: string): Array<{ name: string; filename?: string; data: Buffer }> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundary) throw new Error("multipart boundary missing");
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`), parts: Array<{ name: string; filename?: string; data: Buffer }> = [];
  let start = body.indexOf(marker);
  while (start >= 0) {
    const next = body.indexOf(marker, start + marker.length);
    if (next < 0) break;
    const part = body.subarray(start + marker.length + 2, next - 2), split = part.indexOf("\r\n\r\n");
    if (split >= 0) {
      const head = part.subarray(0, split).toString("utf8");
      const name = /name="([^"]*)"/i.exec(head)?.[1], filename = /filename="([^"]*)"/i.exec(head)?.[1];
      if (name) parts.push({ name, filename, data: part.subarray(split + 4) });
    }
    start = next;
  }
  return parts;
}

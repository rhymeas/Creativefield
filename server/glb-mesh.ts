/*
 * Read the geometry MoGe-2 wrote into a GLB: the POSITION and TEXCOORD_0
 * accessors of its mesh, as two aligned float arrays.
 *
 * Only what the geometry stage needs: the GLB must be a version-2 binary glTF
 * (SaveGLB writes one), the accessors must be float32 components, and the
 * primitive's bufferViews may be interleaved (any byteStride), which is what
 * SaveGLB produces. No three.js / glTF library is involved.
 */
import {parseGlbHeader} from "./glb";

export type GlbMesh = {
  /** Camera-space conversion is the caller's job; these are the raw glTF POSITION values. */
  positions: Float32Array;
  /** TEXCOORD_0 values, aligned with `positions` when `hasUvs`. */
  uvs: Float32Array;
  hasUvs: boolean;
  vertexCount: number;
  primitiveCount: number;
  meshCount: number;
};

type GltfAccessor = {
  bufferView?: number;
  byteOffset?: number;
  componentType?: number;
  count?: number;
  type?: string;
  normalized?: boolean;
};

type GltfBufferView = {buffer?: number; byteOffset?: number; byteLength?: number; byteStride?: number};

export type GltfJson = {
  meshes?: Array<{primitives?: Array<{attributes?: Record<string, number>; mode?: number}>}>;
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: Array<{byteLength?: number; uri?: string}>;
};

const COMPONENT_FLOAT = 5126;
const COMPONENTS: Record<string, number> = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4};

/** Split a GLB into its JSON chunk and its BIN chunk. */
export function parseGlbChunks(bytes: Uint8Array): {json: GltfJson; bin: Uint8Array} {
  parseGlbHeader(bytes, bytes.length); // magic, version 2 and declared length
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let json: GltfJson | undefined;
  let bin: Uint8Array | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + chunkLength > bytes.byteLength) throw new Error("GLB chunk extends past the end of the file");
    const chunk = bytes.subarray(start, start + chunkLength);
    if (chunkType === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk)) as GltfJson;
    else if (chunkType === 0x004e4942) bin = chunk;
    offset = start + chunkLength + ((4 - (chunkLength % 4)) % 4);
  }
  if (!json) throw new Error("GLB has no JSON chunk");
  if (!bin) throw new Error("GLB has no BIN chunk");
  return {json, bin};
}

/** Read one accessor's floats out of the BIN chunk, honouring byteStride and byteOffset. */
function readAccessor(json: GltfJson, bin: Uint8Array, index: number): {data: Float32Array; count: number; itemSize: number} {
  const accessor = json.accessors?.[index];
  if (!accessor) throw new Error(`GLB accessor ${index} is missing`);
  if (accessor.componentType !== COMPONENT_FLOAT) throw new Error(`GLB accessor ${index} is not float32`);
  if (accessor.normalized) throw new Error(`GLB accessor ${index} is normalized; expected raw float32`);
  if (accessor.bufferView === undefined) throw new Error(`GLB accessor ${index} has no bufferView`);
  const bufferView = json.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new Error(`GLB bufferView ${accessor.bufferView} is missing`);
  if (bufferView.buffer !== undefined && bufferView.buffer !== 0) throw new Error("GLB uses an external buffer; only the BIN chunk is supported");
  if (json.buffers?.[bufferView.buffer ?? 0]?.uri) throw new Error("GLB uses an external buffer; only the BIN chunk is supported");
  const itemSize = COMPONENTS[accessor.type ?? ""];
  if (!itemSize) throw new Error(`GLB accessor ${index} has unsupported type ${accessor.type}`);
  const count = accessor.count ?? 0;
  const componentBytes = 4;
  const packed = itemSize * componentBytes;
  const stride = bufferView.byteStride && bufferView.byteStride >= packed ? bufferView.byteStride : packed;
  const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  if (count > 0 && base + stride * (count - 1) + packed > bin.byteLength) throw new Error(`GLB accessor ${index} extends past the BIN chunk`);
  const data = new Float32Array(count * itemSize);
  const dataView = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  for (let item = 0; item < count; item++) {
    const itemOffset = base + item * stride;
    for (let component = 0; component < itemSize; component++) {
      data[item * itemSize + component] = dataView.getFloat32(itemOffset + component * componentBytes, true);
    }
  }
  return {data, count, itemSize};
}

/** All POSITION/TEXCOORD_0 values of a GLB mesh, aligned across primitives when every primitive has UVs. */
export function readGlbMesh(bytes: Uint8Array): GlbMesh {
  const {json, bin} = parseGlbChunks(bytes);
  const meshes = json.meshes ?? [];
  const positionParts: Float32Array[] = [];
  const uvParts: Float32Array[] = [];
  let primitiveCount = 0;
  let everyPrimitiveHasUvs = true;
  for (const mesh of meshes) {
    for (const primitive of mesh.primitives ?? []) {
      primitiveCount += 1;
      const attributes = primitive.attributes ?? {};
      const positionIndex = attributes.POSITION;
      if (positionIndex === undefined) continue;
      const positions = readAccessor(json, bin, positionIndex);
      if (positions.itemSize !== 3) throw new Error("GLB POSITION accessor is not VEC3");
      positionParts.push(positions.data);
      const uvIndex = attributes.TEXCOORD_0;
      if (uvIndex === undefined) {
        everyPrimitiveHasUvs = false;
        continue;
      }
      const uvs = readAccessor(json, bin, uvIndex);
      if (uvs.itemSize !== 2) throw new Error("GLB TEXCOORD_0 accessor is not VEC2");
      if (uvs.count !== positions.count) throw new Error("GLB TEXCOORD_0 and POSITION accessors have different counts");
      uvParts.push(uvs.data);
    }
  }
  const positions = concat(positionParts);
  const vertexCount = positions.length / 3;
  return {
    positions,
    uvs: everyPrimitiveHasUvs ? concat(uvParts) : new Float32Array(0),
    hasUvs: everyPrimitiveHasUvs && uvParts.length > 0,
    vertexCount,
    primitiveCount,
    meshCount: meshes.length,
  };
}

function concat(parts: Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

/**
 * MoGePointMapToMesh converts OpenCV camera space (X right, Y down, Z forward)
 * to glTF (X right, Y up, Z back) as verts * [1, -1, -1]; undo it.
 */
export function gltfToCameraPositions(positions: Float32Array): Float32Array {
  const camera = new Float32Array(positions.length);
  for (let index = 0; index + 2 < positions.length; index += 3) {
    camera[index] = positions[index];
    camera[index + 1] = -positions[index + 1];
    camera[index + 2] = -positions[index + 2];
  }
  return camera;
}

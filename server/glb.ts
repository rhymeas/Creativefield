import { open, stat } from "node:fs/promises";

export type GlbMetadata = { format: "glb"; version: number; bytes: number; contentType: "model/gltf-binary" };

/** Checks the binary glTF header: magic "glTF", version 2 and a declared length equal to the file size. */
export function parseGlbHeader(header: Uint8Array, fileBytes: number): GlbMetadata {
  if (header.length < 12) throw new Error("File is too short to be a GLB model");
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("File is not a binary glTF (GLB) model");
  const version = view.getUint32(4, true), length = view.getUint32(8, true);
  if (version !== 2) throw new Error(`GLB version ${version} is not supported`);
  if (length !== fileBytes) throw new Error("GLB length does not match the file size");
  return { format: "glb", version, bytes: fileBytes, contentType: "model/gltf-binary" };
}

export async function probeGlb(filename: string): Promise<GlbMetadata> {
  const handle = await open(filename, "r");
  try {
    const header = new Uint8Array(12);
    await handle.read(header, 0, 12, 0);
    return parseGlbHeader(header, (await stat(filename)).size);
  } finally {
    await handle.close();
  }
}

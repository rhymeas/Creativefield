import { open } from "node:fs/promises";
import { extname } from "node:path";

/**
 * Bounded, dependency-free structural probe for worker-produced still images.
 * This verifies container structure, checksums where available, dimensions and
 * type metadata; it does not decode compressed pixels. Treat decoder-level
 * validity as an explicit remaining boundary when the worker is untrusted.
 */
export const IMAGE_MAX_BYTES = 64 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 64_000_000;

export type ImageMetadata = {
  contentType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  hasAlpha: boolean;
};

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  return value >>> 0;
});

function dimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > IMAGE_MAX_PIXELS / height) {
    throw new Error("Image dimensions are invalid or too large");
  }
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function probePng(bytes: Buffer): ImageMetadata {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Invalid PNG signature");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let sawHeader = false;
  let sawPalette = false;
  let sawData = false;
  let sawEnd = false;
  let hasTransparencyChunk = false;

  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw new Error("Truncated PNG chunk");
    const length = bytes.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) throw new Error("Truncated PNG chunk");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("Invalid PNG chunk type");
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== bytes.readUInt32BE(dataEnd)) throw new Error("PNG chunk checksum mismatch");

    if (!sawHeader && type !== "IHDR") throw new Error("PNG does not start with IHDR");
    if (/^[A-Z]/.test(type) && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type)) throw new Error("Unsupported critical PNG chunk");
    if (type === "IHDR") {
      if (sawHeader || length !== 13) throw new Error("Invalid PNG IHDR");
      sawHeader = true;
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      const validDepths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!validDepths[colorType]?.includes(bitDepth) || bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0 || bytes[dataStart + 12] > 1) {
        throw new Error("Unsupported PNG header");
      }
      dimensions(width, height);
    } else if (type === "PLTE") {
      if (sawPalette || sawData || colorType === 0 || colorType === 4 || length < 3 || length > 768 || length % 3 !== 0) {
        throw new Error("Invalid PNG palette");
      }
      sawPalette = true;
    } else if (type === "IDAT") {
      if (!sawHeader) throw new Error("PNG data precedes IHDR");
      if (colorType === 3 && !sawPalette) throw new Error("Indexed PNG has no palette");
      sawData = true;
    } else if (type === "tRNS") {
      if (sawData || colorType === 4 || colorType === 6) throw new Error("Invalid PNG transparency chunk");
      if ((colorType === 0 && length !== 2) || (colorType === 2 && length !== 6) || (colorType === 3 && (!sawPalette || length < 1 || length > 256))) {
        throw new Error("Invalid PNG transparency chunk");
      }
      hasTransparencyChunk = true;
    } else if (type === "IEND") {
      if (length !== 0 || !sawData) throw new Error("Invalid PNG IEND");
      sawEnd = true;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
  }

  if (!sawHeader || !sawData || !sawEnd || offset !== bytes.length) throw new Error("Truncated PNG or data after IEND");
  return { contentType: "image/png", width, height, hasAlpha: colorType === 4 || colorType === 6 || hasTransparencyChunk };
}

const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function probeJpeg(bytes: Buffer): ImageMetadata {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Invalid JPEG signature");
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawFrame = false;
  let sawScan = false;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error("Invalid JPEG marker");
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) throw new Error("Truncated JPEG marker");
    const marker = bytes[offset++];

    if (marker === 0xd9) {
      if (!sawFrame || !sawScan || offset !== bytes.length) throw new Error("Invalid JPEG end marker");
      return { contentType: "image/jpeg", width, height, hasAlpha: false };
    }
    if (marker === 0xd8 || marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) throw new Error("Unexpected JPEG marker");
    if (offset + 2 > bytes.length) throw new Error("Truncated JPEG segment");
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error("Truncated JPEG segment");

    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (length < 11) throw new Error("Invalid JPEG frame header");
      const nextHeight = bytes.readUInt16BE(offset + 3);
      const nextWidth = bytes.readUInt16BE(offset + 5);
      const components = bytes[offset + 7];
      if (components < 1 || length !== 8 + 3 * components) throw new Error("Invalid JPEG frame header");
      dimensions(nextWidth, nextHeight);
      if (sawFrame && (width !== nextWidth || height !== nextHeight)) throw new Error("Conflicting JPEG frame dimensions");
      width = nextWidth;
      height = nextHeight;
      sawFrame = true;
    }

    offset += length;
    if (marker !== 0xda) continue;
    if (!sawFrame) throw new Error("JPEG scan precedes frame header");
    sawScan = true;

    // Entropy-coded data ends at the next non-stuffed, non-restart marker.
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const markerStart = offset;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) throw new Error("Truncated JPEG scan");
      const scanMarker = bytes[offset];
      if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
        offset += 1;
        continue;
      }
      offset = markerStart;
      break;
    }
  }
  throw new Error("JPEG has no end marker");
}

function probeWebp(bytes: Buffer): ImageMetadata {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") {
    throw new Error("Invalid WebP signature");
  }
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error("WebP RIFF size does not match file length");

  let offset = 12;
  let canvas: { width: number; height: number; hasAlpha: boolean } | undefined;
  let payload: { width: number; height: number; hasAlpha: boolean } | undefined;
  let payloadKind: "lossy" | "lossless" | undefined;
  let sawAlphaChunk = false;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error("Truncated WebP chunk");
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    const end = data + length;
    const paddedEnd = end + (length & 1);
    if (!Number.isSafeInteger(paddedEnd) || paddedEnd > bytes.length) throw new Error("Truncated WebP chunk");
    if ((length & 1) && bytes[end] !== 0) throw new Error("Invalid WebP padding");

    if (type === "VP8X") {
      if (offset !== 12 || canvas || length !== 10) throw new Error("Invalid WebP extended header");
      const flags = bytes[data];
      if ((flags & 0xc1) !== 0 || (flags & 0x02) !== 0 || bytes[data + 1] !== 0 || bytes[data + 2] !== 0 || bytes[data + 3] !== 0) {
        throw new Error("Unsupported animated or invalid WebP header");
      }
      const width = 1 + bytes.readUIntLE(data + 4, 3);
      const height = 1 + bytes.readUIntLE(data + 7, 3);
      dimensions(width, height);
      canvas = { width, height, hasAlpha: (flags & 0x10) !== 0 };
    } else if (type === "VP8L") {
      if (payload || length < 5 || bytes[data] !== 0x2f) throw new Error("Invalid WebP lossless payload");
      const bits = bytes.readUInt32LE(data + 1);
      if ((bits >>> 29) !== 0) throw new Error("Unsupported WebP lossless version");
      const width = 1 + (bits & 0x3fff);
      const height = 1 + ((bits >>> 14) & 0x3fff);
      dimensions(width, height);
      payload = { width, height, hasAlpha: (bits & 0x10000000) !== 0 };
      payloadKind = "lossless";
    } else if (type === "VP8 ") {
      if (payload || length < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) {
        throw new Error("Invalid WebP lossy payload");
      }
      const width = bytes.readUInt16LE(data + 6) & 0x3fff;
      const height = bytes.readUInt16LE(data + 8) & 0x3fff;
      dimensions(width, height);
      payload = { width, height, hasAlpha: false };
      payloadKind = "lossy";
    } else if (type === "ALPH") {
      if (length < 1) throw new Error("Invalid WebP alpha chunk");
      sawAlphaChunk = true;
    }
    offset = paddedEnd;
  }

  if (!payload || offset !== bytes.length) throw new Error("WebP has no image payload");
  if (canvas && (canvas.width !== payload.width || canvas.height !== payload.height)) throw new Error("WebP canvas dimensions do not match payload");
  if (!canvas && sawAlphaChunk) throw new Error("WebP alpha chunk requires an extended header");
  if (sawAlphaChunk && payloadKind !== "lossy") throw new Error("WebP alpha chunk requires a lossy image payload");
  if (canvas && canvas.hasAlpha !== (sawAlphaChunk || payload.hasAlpha)) throw new Error("WebP alpha flag does not match its payload");
  const width = canvas?.width ?? payload.width;
  const height = canvas?.height ?? payload.height;
  const hasAlpha = canvas?.hasAlpha ?? payload.hasAlpha;
  return { contentType: "image/webp", width, height, hasAlpha };
}

export function probeImageBytes(bytes: Buffer): ImageMetadata {
  if (bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES) throw new Error("Image is empty or oversized");
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return probePng(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return probeJpeg(bytes);
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return probeWebp(bytes);
  throw new Error("Output is not a supported PNG, JPEG or WebP image");
}

export async function probeImage(filename: string): Promise<ImageMetadata> {
  const handle = await open(filename, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0 || info.size > IMAGE_MAX_BYTES) throw new Error("Image is empty or oversized");
    const bytes = await handle.readFile();
    if (bytes.length !== info.size || bytes.length > IMAGE_MAX_BYTES) throw new Error("Image changed while it was being read");
    return probeImageBytes(bytes);
  } finally {
    await handle.close();
  }
}

/** Extension must agree with the sniffed content type; renaming a file never changes its semantics. */
export function assertImageExtension(name: string, contentType: ImageMetadata["contentType"]): void {
  const extension = extname(name).toLowerCase();
  const valid = contentType === "image/png"
    ? extension === ".png"
    : contentType === "image/jpeg"
      ? extension === ".jpg" || extension === ".jpeg"
      : extension === ".webp";
  if (!valid) throw new Error("Image extension does not match its content");
}

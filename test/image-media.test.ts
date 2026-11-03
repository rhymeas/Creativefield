import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  assertImageExtension,
  IMAGE_MAX_BYTES,
  probeImage,
  probeImageBytes,
} from "../server/image-media";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function png(width = 1, height = 1, colorType = 6): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  const pixel = colorType === 6 ? Buffer.from([0, 255, 0, 0, 128]) : Buffer.from([0, 255, 0, 0]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixel)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const JPEG_1X1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=",
  "base64",
);

// A complete 1x1 lossy WebP RIFF. The source string contains four bytes beyond its
// declared RIFF; slicing makes the fixture exactly the encoded file, not an accepted tail.
const WEBP_1X1 = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==", "base64").subarray(0, 42);

describe("image media probing", () => {
  it("probes an existing encoded PNG fixture from disk", async () => {
    const filename = resolve("test/assets/render-test.png");
    await expect(probeImage(filename)).resolves.toEqual({
      contentType: "image/png",
      width: 1280,
      height: 704,
      hasAlpha: false,
    });
    expect((await readFile(filename)).length).toBeGreaterThan(100);
  });

  it("reports PNG alpha from the encoded color type", () => {
    expect(probeImageBytes(png())).toEqual({ contentType: "image/png", width: 1, height: 1, hasAlpha: true });
    expect(probeImageBytes(png(1, 1, 2))).toEqual({ contentType: "image/png", width: 1, height: 1, hasAlpha: false });
  });

  it("rejects truncated, corrupt, trailing, and oversized PNGs", () => {
    const valid = png();
    expect(() => probeImageBytes(valid.subarray(0, -1))).toThrow(/truncated|IEND/i);
    const corrupt = Buffer.from(valid);
    corrupt[corrupt.length - 5] ^= 1;
    expect(() => probeImageBytes(corrupt)).toThrow(/checksum/i);
    expect(() => probeImageBytes(Buffer.concat([valid, Buffer.from([0])]))).toThrow(/after IEND/i);
    expect(() => probeImageBytes(png(10_000, 10_000))).toThrow(/dimensions/i);
  });

  it("probes complete JPEG and WebP byte fixtures", () => {
    expect(probeImageBytes(JPEG_1X1)).toEqual({ contentType: "image/jpeg", width: 1, height: 1, hasAlpha: false });
    expect(probeImageBytes(WEBP_1X1)).toEqual({ contentType: "image/webp", width: 1, height: 1, hasAlpha: false });
  });

  it("rejects truncated JPEG and malformed or mismatched WebP RIFF", () => {
    expect(() => probeImageBytes(JPEG_1X1.subarray(0, -2))).toThrow(/end marker|truncated/i);
    expect(() => probeImageBytes(WEBP_1X1.subarray(0, -1))).toThrow(/RIFF size/i);
    const badWebp = Buffer.from(WEBP_1X1);
    badWebp.writeUInt32LE(badWebp.readUInt32LE(4) + 2, 4);
    expect(() => probeImageBytes(badWebp)).toThrow(/RIFF size/i);
  });

  it("rejects empty, unsupported, and byte-oversized inputs", () => {
    expect(() => probeImageBytes(Buffer.alloc(0))).toThrow(/empty|oversized/i);
    expect(() => probeImageBytes(Buffer.from("not an image"))).toThrow(/supported/i);
    expect(() => probeImageBytes(Buffer.allocUnsafe(IMAGE_MAX_BYTES + 1))).toThrow(/oversized/i);
  });
});

describe("image extension agreement", () => {
  it("accepts only extensions that match the probed content", () => {
    expect(() => assertImageExtension("result.PNG", "image/png")).not.toThrow();
    expect(() => assertImageExtension("result.jpg", "image/jpeg")).not.toThrow();
    expect(() => assertImageExtension("result.JPEG", "image/jpeg")).not.toThrow();
    expect(() => assertImageExtension("result.webp", "image/webp")).not.toThrow();
    expect(() => assertImageExtension("result.png", "image/jpeg")).toThrow(/does not match/i);
    expect(() => assertImageExtension("result.png.exe", "image/png")).toThrow(/does not match/i);
    expect(() => assertImageExtension("result", "image/png")).toThrow(/does not match/i);
  });
});

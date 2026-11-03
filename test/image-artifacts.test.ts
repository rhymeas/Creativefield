import {describe, expect, it} from "vitest";
import sharp from "sharp";
import {
  PngValidationError,
  validatePngBytes,
} from "../server/image-artifacts-validation";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  typeBytes.copy(header, 4);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([header, data, checksum]);
}

function chunkOffset(png: Buffer, wanted: string): number {
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === wanted) return offset;
    offset += 12 + length;
  }
  return -1;
}

async function rgbPng(width: number, height: number): Promise<Buffer> {
  return sharp(Buffer.alloc(width * height * 3, 127), {raw: {width, height, channels: 3}}).png().toBuffer();
}

async function rgbaPng(alpha: number[]): Promise<Buffer> {
  const pixels = Buffer.alloc(alpha.length * 4);
  alpha.forEach((value, index) => {
    pixels.set([30, 80, 160, value], index * 4);
  });
  return sharp(pixels, {raw: {width: alpha.length, height: 1, channels: 4}}).png().toBuffer();
}

async function indexedTransparentPng(): Promise<Buffer> {
  const pixels = Buffer.from([
    255, 0, 0, 255,
    0, 0, 255, 0,
  ]);
  return sharp(pixels, {raw: {width: 2, height: 1, channels: 4}})
    .png({palette: true, colours: 2})
    .toBuffer();
}

function expectCode(code: PngValidationError["code"]) {
  return expect.objectContaining({name: "PngValidationError", code});
}

describe("bounded PNG validation", () => {
  it("fully decodes opaque RGB pixels and preserves the original bytes", async () => {
    const png = await rgbPng(3, 2);
    const result = await validatePngBytes(png);

    expect(result).toMatchObject({width: 3, height: 2, hasAlpha: false});
    expect(result.bytes).toEqual(png);
    expect(result.bytes).not.toBe(png);
  });

  it("reports actual translucent RGBA pixels rather than alpha channel capability", async () => {
    await expect(validatePngBytes(await rgbaPng([255, 128])))
      .resolves.toMatchObject({width: 2, height: 1, hasAlpha: true});
    await expect(validatePngBytes(await rgbaPng([255, 255])))
      .resolves.toMatchObject({width: 2, height: 1, hasAlpha: false});
  });

  it("decodes indexed tRNS transparency", async () => {
    const png = await indexedTransparentPng();
    const ihdr = chunkOffset(png, "IHDR");
    expect(ihdr).toBe(8);
    expect(png[ihdr + 17]).toBe(3);
    expect(chunkOffset(png, "tRNS")).toBeGreaterThan(0);
    await expect(validatePngBytes(png)).resolves.toMatchObject({hasAlpha: true});
  });

  it("rejects non-PNG, truncated, and header-only containers", async () => {
    await expect(validatePngBytes(Buffer.from("not a png"))).rejects.toMatchObject(expectCode("invalid_png"));

    const valid = await rgbPng(2, 2);
    await expect(validatePngBytes(valid.subarray(0, valid.length - 5)))
      .rejects.toMatchObject(expectCode("invalid_png"));

    const ihdrOffset = chunkOffset(valid, "IHDR");
    const ihdrLength = valid.readUInt32BE(ihdrOffset);
    const headerOnly = Buffer.concat([
      valid.subarray(0, ihdrOffset + 12 + ihdrLength),
      pngChunk("IEND"),
    ]);
    await expect(validatePngBytes(headerOnly)).rejects.toMatchObject(expectCode("invalid_png"));
  });

  it("rejects corrupt pixel data after syntactically valid metadata", async () => {
    const valid = await rgbPng(4, 4);
    const corrupted = Buffer.from(valid);
    const idatOffset = chunkOffset(corrupted, "IDAT");
    expect(idatOffset).toBeGreaterThan(0);
    corrupted[idatOffset + 8] ^= 0xff;

    await expect(validatePngBytes(corrupted)).rejects.toMatchObject(expectCode("invalid_png"));
  });

  it("rejects APNG control chunks even when a static default image can be decoded", async () => {
    const valid = await rgbPng(2, 2);
    const idatOffset = chunkOffset(valid, "IDAT");
    const animation = Buffer.alloc(8);
    animation.writeUInt32BE(2, 0);
    animation.writeUInt32BE(0, 4);
    const apng = Buffer.concat([valid.subarray(0, idatOffset), pngChunk("acTL", animation), valid.subarray(idatOffset)]);

    await expect(validatePngBytes(apng)).rejects.toMatchObject(expectCode("animated_png"));
  });

  it("enforces byte, dimension, and decoded-pixel limits", async () => {
    const png = await rgbPng(4, 3);
    await expect(validatePngBytes(png, {maxBytes: png.length - 1}))
      .rejects.toMatchObject(expectCode("input_too_large"));
    await expect(validatePngBytes(png, {maxWidth: 3}))
      .rejects.toMatchObject(expectCode("dimensions_too_large"));
    await expect(validatePngBytes(png, {maxHeight: 2}))
      .rejects.toMatchObject(expectCode("dimensions_too_large"));
    await expect(validatePngBytes(png, {maxPixels: 11}))
      .rejects.toMatchObject(expectCode("pixels_too_large"));
  });

  it("rejects empty input and invalid caller limits with stable errors", async () => {
    await expect(validatePngBytes(Buffer.alloc(0))).rejects.toMatchObject(expectCode("invalid_input"));
    await expect(validatePngBytes(await rgbPng(1, 1), {maxPixels: 0})).rejects.toBeInstanceOf(RangeError);
  });
});

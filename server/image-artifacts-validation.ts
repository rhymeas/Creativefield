import sharp from "sharp";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const DEFAULT_PNG_VALIDATION_LIMITS = Object.freeze({
  maxBytes: 25 * 1024 * 1024,
  maxWidth: 8192,
  maxHeight: 8192,
  maxPixels: 40_000_000,
});

export type PngValidationErrorCode =
  | "invalid_input"
  | "input_too_large"
  | "invalid_png"
  | "animated_png"
  | "dimensions_too_large"
  | "pixels_too_large";

export class PngValidationError extends Error {
  readonly code: PngValidationErrorCode;

  constructor(code: PngValidationErrorCode, message: string) {
    super(message);
    this.name = "PngValidationError";
    this.code = code;
  }
}

export interface PngValidationLimits {
  maxBytes?: number;
  maxWidth?: number;
  maxHeight?: number;
  maxPixels?: number;
}

export interface ValidatedPng {
  width: number;
  height: number;
  hasAlpha: boolean;
  /** The submitted bytes, copied exactly and never re-encoded. */
  bytes: Buffer;
}

interface ResolvedLimits {
  maxBytes: number;
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function resolveLimits(overrides: PngValidationLimits): ResolvedLimits {
  return {
    maxBytes: positiveSafeInteger(overrides.maxBytes ?? DEFAULT_PNG_VALIDATION_LIMITS.maxBytes, "maxBytes"),
    maxWidth: positiveSafeInteger(overrides.maxWidth ?? DEFAULT_PNG_VALIDATION_LIMITS.maxWidth, "maxWidth"),
    maxHeight: positiveSafeInteger(overrides.maxHeight ?? DEFAULT_PNG_VALIDATION_LIMITS.maxHeight, "maxHeight"),
    maxPixels: positiveSafeInteger(overrides.maxPixels ?? DEFAULT_PNG_VALIDATION_LIMITS.maxPixels, "maxPixels"),
  };
}

function rejectMalformedPng(): never {
  throw new PngValidationError("invalid_png", "The image is not a valid PNG file.");
}

/**
 * Checks enough of the container to reject ambiguous/truncated files and APNG
 * before invoking the decoder. Pixel validity is established separately by
 * libpng through sharp; this parser is not used as proof that an image is safe.
 */
function inspectPngContainer(bytes: Buffer): {width: number; height: number} {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    rejectMalformedPng();
  }

  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let sawIend = false;
  let declaredWidth = 0;
  let declaredHeight = 0;

  while (offset < bytes.length) {
    if (bytes.length - offset < 12) rejectMalformedPng();

    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) rejectMalformedPng();

    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== 13) rejectMalformedPng();
      declaredWidth = bytes.readUInt32BE(offset + 8);
      declaredHeight = bytes.readUInt32BE(offset + 12);
    }
    if (type === "acTL") {
      throw new PngValidationError("animated_png", "Animated PNG files are not supported.");
    }
    if (type === "IEND") {
      if (length !== 0 || chunkEnd !== bytes.length) rejectMalformedPng();
      sawIend = true;
      offset = chunkEnd;
      break;
    }

    offset = chunkEnd;
    chunkIndex += 1;
  }

  if (!sawIend || offset !== bytes.length) rejectMalformedPng();
  return {width: declaredWidth, height: declaredHeight};
}

function decoder(bytes: Buffer, maxPixels: number) {
  return sharp(bytes, {
    animated: true,
    failOn: "warning",
    limitInputPixels: maxPixels,
    limitInputChannels: 4,
    sequentialRead: true,
    unlimited: false,
  });
}

/**
 * Strictly validates and fully decodes a PNG supplied in memory.
 *
 * The returned bytes are an exact copy of the submitted bytes. They are never
 * normalized or re-encoded, which allows ingestion to hash and publish the
 * precise object that was validated.
 */
export async function validatePngBytes(
  input: Uint8Array,
  limitOverrides: PngValidationLimits = {},
): Promise<ValidatedPng> {
  if (!(input instanceof Uint8Array) || input.byteLength === 0) {
    throw new PngValidationError("invalid_input", "PNG input must contain bytes.");
  }

  const limits = resolveLimits(limitOverrides);
  if (input.byteLength > limits.maxBytes) {
    throw new PngValidationError("input_too_large", "The PNG file exceeds the allowed byte size.");
  }

  const bytes = Buffer.from(input);
  // Header geometry is used only to reject work before decoding, never to
  // accept it. The decoder-reported geometry is checked again below.
  const declared = inspectPngContainer(bytes);
  if (declared.width <= 0 || declared.height <= 0) rejectMalformedPng();
  if (declared.width > limits.maxWidth || declared.height > limits.maxHeight) {
    throw new PngValidationError("dimensions_too_large", "The PNG dimensions exceed the allowed size.");
  }
  const declaredPixels = declared.width * declared.height;
  if (!Number.isSafeInteger(declaredPixels) || declaredPixels > limits.maxPixels) {
    throw new PngValidationError("pixels_too_large", "The PNG pixel count exceeds the allowed size.");
  }

  try {
    const metadata = await decoder(bytes, limits.maxPixels).metadata();
    if (metadata.format !== "png" || metadata.width === undefined || metadata.height === undefined) {
      rejectMalformedPng();
    }
    if (metadata.width !== declared.width || metadata.height !== declared.height) rejectMalformedPng();
    if (metadata.pages !== undefined && metadata.pages !== 1) {
      throw new PngValidationError("animated_png", "Animated PNG files are not supported.");
    }
    if (metadata.width <= 0 || metadata.height <= 0) rejectMalformedPng();
    if (metadata.width > limits.maxWidth || metadata.height > limits.maxHeight) {
      throw new PngValidationError("dimensions_too_large", "The PNG dimensions exceed the allowed size.");
    }

    const pixels = metadata.width * metadata.height;
    if (!Number.isSafeInteger(pixels) || pixels > limits.maxPixels) {
      throw new PngValidationError("pixels_too_large", "The PNG pixel count exceeds the allowed size.");
    }

    const decoded = await decoder(bytes, limits.maxPixels)
      .toColourspace("srgb")
      .ensureAlpha()
      .raw({depth: "uchar"})
      .toBuffer({resolveWithObject: true});

    if (
      decoded.info.width !== metadata.width
      || decoded.info.height !== metadata.height
      || decoded.info.channels !== 4
      || decoded.data.length !== pixels * 4
    ) {
      rejectMalformedPng();
    }

    let hasAlpha = false;
    for (let index = 3; index < decoded.data.length; index += 4) {
      if (decoded.data[index] !== 255) {
        hasAlpha = true;
        break;
      }
    }

    return {width: metadata.width, height: metadata.height, hasAlpha, bytes};
  } catch (error) {
    if (error instanceof PngValidationError) throw error;
    throw new PngValidationError("invalid_png", "The image is not a valid PNG file.");
  }
}

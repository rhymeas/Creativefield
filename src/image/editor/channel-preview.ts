export type PreviewChannel = "rgb" | "r" | "g" | "b" | "a";

/** Individual channels are opaque grayscale intensities; RGB retains transparency. */
export function channelPixels(source: Uint8ClampedArray, channel: PreviewChannel): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(source);
  if (channel === "rgb") return pixels;
  const offset = { r: 0, g: 1, b: 2, a: 3 }[channel];
  for (let i = 0; i < pixels.length; i += 4) {
    const value = source[i + offset];
    pixels[i] = pixels[i + 1] = pixels[i + 2] = value;
    pixels[i + 3] = 255;
  }
  return pixels;
}

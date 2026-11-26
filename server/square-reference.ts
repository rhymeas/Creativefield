import sharp from "sharp";

/** MiniMax H3-Image brings every picture to a 1024-2048 px short edge, so a wide reference costs far more than its
 *  content needs: a 2172x724 wordmark became 3072x1024 and an 8 MP edit took 109 s instead of 77 s with the same
 *  wordmark on a square (IDEA-2466, 2026-11-21). Above this side ratio a reference goes on a square canvas. */
export const SQUARE_REFERENCE_RATIO = 1.25;
/** The longest side of a prepared reference. The node's vision encoder reads references at a 1024 px short edge
 *  (IMAGE_REF_SHORT_EDGE) and only the reference latents go up to 2048, where they ride through every sampling step:
 *  two 2048 px square sheet references made an 8 MP edit take 136 s (trailer stress test, 2026-11-21). */
export const SQUARE_REFERENCE_MAX_SIDE = 1024;

/** The reference at most 1024 px on its long side, and when it is wide or tall, centred on a square canvas filled with
 *  the mean colour of its own border, so a yellow wordmark stays a yellow wordmark instead of becoming a yellow card
 *  on white. Undefined when the picture is near square and small enough already. */
export async function squareReference(bytes: Buffer): Promise<Buffer | undefined> {
  const input = sharp(bytes, {animated: false, limitInputPixels: 64 * 1024 * 1024, failOn: "warning"});
  const original = await input.metadata();
  const image = sharp(await input.rotate()
    .resize({width: SQUARE_REFERENCE_MAX_SIDE, height: SQUARE_REFERENCE_MAX_SIDE, fit: "inside", withoutEnlargement: true}).png().toBuffer());
  const {data, info} = await image.clone().removeAlpha().raw().toBuffer({resolveWithObject: true});
  const {width, height, channels} = info;
  if (!width || !height) return undefined;
  if (Math.max(width, height) / Math.min(width, height) < SQUARE_REFERENCE_RATIO) {
    const shrunk = Math.max(original.width ?? 0, original.height ?? 0) > SQUARE_REFERENCE_MAX_SIDE;
    return shrunk ? image.png().toBuffer() : undefined;
  }
  const sum = [0, 0, 0];
  let count = 0;
  const add = (x: number, y: number) => { const i = (y * width + x) * channels; for (let c = 0; c < 3; c++) sum[c] += data[i + c]; count++; };
  for (let x = 0; x < width; x++) { add(x, 0); add(x, height - 1); }
  for (let y = 1; y < height - 1; y++) { add(0, y); add(width - 1, y); }
  const [r, g, b] = sum.map(v => Math.round(v / count));
  const side = Math.max(width, height);
  const left = Math.floor((side - width) / 2), top = Math.floor((side - height) / 2);
  return image.extend({left, right: side - width - left, top, bottom: side - height - top, background: {r, g, b, alpha: 1}}).png().toBuffer();
}

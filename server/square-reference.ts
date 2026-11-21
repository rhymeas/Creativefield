import sharp from "sharp";

/** MiniMax H3-Image brings every picture to a 1024-2048 px short edge, so a wide reference costs far more than its
 *  content needs: a 2172x724 wordmark became 3072x1024 and an 8 MP edit took 109 s instead of 77 s with the same
 *  wordmark on a square (IDEA-2466, 2026-11-21). Above this side ratio a reference goes on a square canvas. */
export const SQUARE_REFERENCE_RATIO = 1.25;
/** The longest side a squared reference may have, so the square canvas stays at most 2048 x 2048. */
export const SQUARE_REFERENCE_MAX_SIDE = 2048;

/** The reference centred on a square canvas filled with the mean colour of its own border, so a yellow wordmark
 *  stays a yellow wordmark instead of becoming a yellow card on white. Undefined when it is near square already. */
export async function squareReference(bytes: Buffer): Promise<Buffer | undefined> {
  // The long edge is capped first: H3 reads references within a 2048 px short edge anyway, and an uncapped extend of a
  // very wide picture would build a canvas far larger than the input limit allows (at most 2048 x 2048 here).
  const image = sharp(await sharp(bytes, {animated: false, limitInputPixels: 64 * 1024 * 1024, failOn: "warning"}).rotate()
    .resize({width: SQUARE_REFERENCE_MAX_SIDE, height: SQUARE_REFERENCE_MAX_SIDE, fit: "inside", withoutEnlargement: true}).png().toBuffer());
  const {data, info} = await image.clone().removeAlpha().raw().toBuffer({resolveWithObject: true});
  const {width, height, channels} = info;
  if (!width || !height || Math.max(width, height) / Math.min(width, height) < SQUARE_REFERENCE_RATIO) return undefined;
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

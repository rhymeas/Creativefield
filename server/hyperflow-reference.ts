import sharp from "sharp";
import { IMAGE_MAX_PIXELS } from "./image-media";

const stillWorkflows = new Set([
  "h3-effects-hyperflow",
  "hyperflow-h3-flash-i2v",
  "hyperflow-h3-flash-flf2v",
  "hyperflow-h3-flash-flf2v-deno",
]);

/** The local video graphs expect a single frame in each image slot. */
export async function hyperflowStillReference(source: string, workflowId: string, role: string, contentType: string): Promise<Buffer | undefined> {
  if (!stillWorkflows.has(workflowId) || (role !== "start_image" && role !== "end_image")) return;
  if (contentType !== "image/webp" && contentType !== "image/gif") return;
  const image = sharp(source, { pages: 1, limitInputPixels: IMAGE_MAX_PIXELS });
  const { pages = 1 } = await image.metadata();
  if (pages > 1) return image.rotate().png().toBuffer();
}

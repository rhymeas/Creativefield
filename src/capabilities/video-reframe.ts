export const VIDEO_REFRAME_ID = "hyperflow-video-reframe";
export const VIDEO_REFRAME_HASH = "#video/transform/reframe";

export const REFRAME_SIZES = {
  "16:9 landscape": {width: 1024, height: 576},
  "9:16 portrait": {width: 576, height: 1024},
  "1:1 square": {width: 768, height: 768},
} as const;

export function reframeSize(value: unknown) {
  if (typeof value !== "string" || !Object.hasOwn(REFRAME_SIZES, value)) return;
  return REFRAME_SIZES[value as keyof typeof REFRAME_SIZES];
}

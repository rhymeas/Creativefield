/** Transform math for the full-view image zoom, kept out of MediaViewer so it can be tested. */
export type ViewerTransform = { scale: number; x: number; y: number };
export type ViewerBounds = { width: number; height: number };

export const VIEWER_FIT: ViewerTransform = { scale: 1, x: 0, y: 0 };
export const VIEWER_MIN_ZOOM = 1;
export const VIEWER_MAX_ZOOM = 8;

/** A wheel delta as a zoom factor: wheel up (negative delta) zooms in. */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.0015);
}

function clampTranslation(value: number, size: number, scale: number): number {
  return Math.min(0, Math.max(size - size * scale, value));
}

/** Zoom around a point in the displayed image, keeping that point under the pointer. */
export function zoomViewer(
  view: ViewerTransform,
  factor: number,
  cursor: { x: number; y: number },
  bounds: ViewerBounds,
  max = VIEWER_MAX_ZOOM,
): ViewerTransform {
  const scale = Math.min(max, Math.max(VIEWER_MIN_ZOOM, view.scale * factor));
  if (scale === VIEWER_MIN_ZOOM) return VIEWER_FIT;
  if (!(bounds.width > 0) || !(bounds.height > 0)) return { ...VIEWER_FIT, scale };
  const ratio = scale / view.scale;
  return {
    scale,
    x: clampTranslation(cursor.x - (cursor.x - view.x) * ratio, bounds.width, scale),
    y: clampTranslation(cursor.y - (cursor.y - view.y) * ratio, bounds.height, scale),
  };
}

/** Move a zoomed image by a pointer delta, never showing an empty edge. */
export function panViewer(view: ViewerTransform, dx: number, dy: number, bounds: ViewerBounds): ViewerTransform {
  if (view.scale <= VIEWER_MIN_ZOOM) return VIEWER_FIT;
  return {
    scale: view.scale,
    x: clampTranslation(view.x + dx, bounds.width, view.scale),
    y: clampTranslation(view.y + dy, bounds.height, view.scale),
  };
}

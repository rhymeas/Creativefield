import { describe, expect, it } from "vitest";
import { analyseCamera, cameraVerdict } from "../scripts/camera-check-lib.mjs";

const W = 96, H = 54;
/* A smooth texture that is defined everywhere, so shifting or scaling it needs no edge handling. */
const texture = (x: number, y: number) => 128 + 60 * Math.sin(x * 0.31 + Math.sin(y * 0.17) * 2) + 50 * Math.cos(y * 0.23 + x * 0.05) + 15 * Math.sin((x + y) * 0.9);
const frame = (dx: number, dy: number, scale: number) => {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    out[y * W + x] = Math.max(0, Math.min(255, Math.round(texture((x - W / 2 - dx) / scale + W / 2, (y - H / 2 - dy) / scale + H / 2))));
  return out;
};
const clip = (end: { dx?: number; dy?: number; scale?: number }) =>
  Array.from({ length: 9 }, (_, i) => frame(((end.dx ?? 0) * i) / 8, ((end.dy ?? 0) * i) / 8, 1 + (((end.scale ?? 1) - 1) * i) / 8));

describe("camera check", () => {
  it("reads a content shift to the right as a pan left, and the reverse as a pan right", () => {
    const left = analyseCamera(clip({ dx: 6 }), W, H);
    expect(left.dx).toBeGreaterThan(0.05);
    expect(cameraVerdict(left, "pan-left").followed).toBe(true);
    expect(cameraVerdict(left, "pan-right").followed).toBe(false);
    expect(cameraVerdict(analyseCamera(clip({ dx: -6 }), W, H), "pan-right").followed).toBe(true);
  });

  it("reads vertical shifts", () => {
    expect(cameraVerdict(analyseCamera(clip({ dy: 4 }), W, H), "pan-up").followed).toBe(true);
    expect(cameraVerdict(analyseCamera(clip({ dy: -4 }), W, H), "pan-down").followed).toBe(true);
    expect(cameraVerdict(analyseCamera(clip({ dy: 4 }), W, H), "pan-down").followed).toBe(false);
  });

  it("reads growth as a zoom in and shrinking as a zoom out", () => {
    expect(cameraVerdict(analyseCamera(clip({ scale: 1.1 }), W, H), "zoom-in").followed).toBe(true);
    expect(cameraVerdict(analyseCamera(clip({ scale: 0.9 }), W, H), "zoom-out").followed).toBe(true);
    expect(cameraVerdict(analyseCamera(clip({ scale: 1.1 }), W, H), "zoom-out").followed).toBe(false);
  });

  it("says a picture that hardly moves did not follow any move", () => {
    const still = analyseCamera(clip({}), W, H);
    for (const move of ["pan-left", "pan-up", "zoom-in"] as const) {
      const verdict = cameraVerdict(still, move);
      expect(verdict.followed).toBe(false);
      expect(verdict.reason).toContain("hardly moved");
    }
  });
});

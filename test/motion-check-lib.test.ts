import { describe, expect, it } from "vitest";
import { analyseFrames, motionVerdict } from "../scripts/motion-check-lib.mjs";

const W = 12, H = 12, N = 20;
/** A clip whose pixel at (x, y, t) is given by the function, clamped to a byte. */
const clip = (pixel: (x: number, y: number, t: number) => number) =>
  Array.from({ length: N }, (_, t) => Uint8Array.from({ length: W * H }, (_, i) => Math.max(0, Math.min(255, Math.round(pixel(i % W, Math.floor(i / W), t))))));
const level = (frames: Uint8Array[]) => motionVerdict(analyseFrames(frames, W, H)).level;

describe("motion check", () => {
  it("calls a still picture static, even with a little codec-like noise", () => {
    expect(level(clip((x, y) => 40 + x * 5 + y))).toBe("static");
    expect(level(clip((x, y, t) => 40 + x * 5 + y + (t % 2 ? 1 : 0)))).toBe("static");
  });

  it("calls a fade from one picture to another static: nothing moves, one value turns into another", () => {
    expect(level(clip((x, y, t) => (40 + x * 5) * (1 - t / (N - 1)) + (200 - y * 6) * (t / (N - 1))))).toBe("static");
    expect(level(clip((x, _y, t) => 30 + 150 * Math.pow(t / (N - 1), 3) + x))).toBe("static");
  });

  it("calls a picture where every part moves alive", () => {
    expect(level(clip((x, y, t) => 120 + 60 * Math.sin((x + y) / 2 + t * 0.9)))).toBe("alive");
  });

  it("calls a picture where only one third moves partial, and names the parts that do not", () => {
    const frames = clip((x, y, t) => (y >= 8 ? 120 + 60 * Math.sin(x / 2 + t * 0.9) : 90 + x));
    const motion = analyseFrames(frames, W, H);
    expect(motionVerdict(motion)).toMatchObject({ level: "partial" });
    expect(motionVerdict(motion).reason).toContain("top and middle");
    expect(motion.bottom).toBeGreaterThan(motion.top);
  });

  it("refuses a clip too short to judge and frames of the wrong size", () => {
    expect(() => analyseFrames(clip(() => 0).slice(0, 4), W, H)).toThrow("at least five frames");
    expect(() => analyseFrames([new Uint8Array(3), ...clip(() => 0).slice(1)], W, H)).toThrow("width x height");
  });
});

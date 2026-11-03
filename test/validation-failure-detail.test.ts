import {describe, expect, it} from "vitest";
import {z} from "zod";
import {validationFailureDetail} from "../server/execution";

describe("validation failure details", () => {
  it("names the fields a schema rejected", () => {
    const error = z.object({media: z.string(), frames: z.number()}).safeParse({media: 1, frames: "two"}).error!;
    const detail = validationFailureDetail(error)!;
    expect(detail).toContain("media:");
    expect(detail).toContain("frames:");
    expect(detail).not.toContain("\n");
  });

  it("passes a real message through, trimmed to 300 characters", () => {
    expect(validationFailureDetail(new Error("  expected a PNG, found a JPEG  "))).toBe("expected a PNG, found a JPEG");
    const long = validationFailureDetail(new Error("x".repeat(400)))!;
    expect(long.length).toBe(300);
  });

  it("stays quiet rather than repeating the sentence it would duplicate", () => {
    expect(validationFailureDetail(new Error("Worker output failed validation"))).toBeUndefined();
    expect(validationFailureDetail(undefined)).toBeUndefined();
    expect(validationFailureDetail("just a string")).toBeUndefined();
  });
});

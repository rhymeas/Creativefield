import { describe, expect, it } from "vitest";
import { selectProblems } from "../src/ds/problems";

describe("problem consolidation", () => {
  it("keeps follow-on errors out even when distinct causes are expanded", () => {
    expect(selectProblems([
      { key: "Connection lost", priority: 100, consequence: false },
      { key: "Workspace request failed", priority: 50, consequence: true },
      { key: "Cannot queue", priority: 30, consequence: true },
      { key: "Unsupported image", priority: 40, consequence: false },
    ])).toEqual([0, 3]);
  });
  it("deduplicates the same failure and keeps the highest-priority action", () => {
    expect(selectProblems([
      { key: "Connection lost", priority: 10, consequence: false },
      { key: " Connection  lost ", priority: 100, consequence: false },
    ])).toEqual([1]);
  });
  it("keeps different resource names distinct", () => {
    expect(selectProblems([
      { key: "Upload failed: ImageA.png", priority: 10, consequence: false },
      { key: "Upload failed: imagea.png", priority: 10, consequence: false },
    ])).toEqual([0, 1]);
  });
  it("reveals a still-relevant consequence after its cause clears", () => {
    expect(selectProblems([{ key: "Upload failed", priority: 30, consequence: true }])).toEqual([0]);
    expect(selectProblems([])).toEqual([]);
  });
});

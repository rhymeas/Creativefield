import { describe, expect, it } from "vitest";
import { dockLayout, reorderVisible } from "../src/ds/dock-layout";

const items = [
  { id: "color", top: 0, height: 300 },
  { id: "layers", top: 316, height: 180 },
  { id: "properties", top: 512, height: 240 },
];

describe("panel docking", () => {
  it("keeps the original order until a sibling midpoint is crossed", () => {
    expect(dockLayout(items, "color", 100, 16).map(item => item.id)).toEqual(["color", "layers", "properties"]);
    expect(dockLayout(items, "color", 110, 16).map(item => item.id)).toEqual(["layers", "color", "properties"]);
  });

  it("makes room for differently sized panels without overlap", () => {
    expect(dockLayout(items, "color", 600, 16)).toEqual([
      { id: "layers", top: 0, height: 180 },
      { id: "properties", top: 196, height: 240 },
      { id: "color", top: 452, height: 300 },
    ]);
  });

  it("moves the last panel to the first slot and can return to its original position", () => {
    expect(dockLayout(items, "properties", -600, 16).map(item => item.id)).toEqual(["properties", "color", "layers"]);
    expect(dockLayout(items, "properties", 0, 16)).toEqual(items);
  });

  it("can move a tall panel past a short collapsed panel without leaving the stack", () => {
    const mixed = [{ id: "color", top: 0, height: 400 }, { id: "layers", top: 416, height: 40 }];
    expect(dockLayout(mixed, "color", 56, 16).map(item => item.id)).toEqual(["layers", "color"]);
  });

  it("does not mutate the source during a preview or cancel", () => {
    const snapshot = structuredClone(items);
    dockLayout(items, "color", 600, 16);
    expect(items).toEqual(snapshot);
    expect(dockLayout(items, "unavailable", 600, 16)).toBe(items);
  });

  it("keeps unavailable AI panels in their saved slot", () => {
    expect(reorderVisible(["color", "layers", "ai", "properties"], ["properties", "color", "layers"]))
      .toEqual(["properties", "color", "ai", "layers"]);
  });

  it("ignores duplicate or unknown panel identities", () => {
    expect(reorderVisible(["color", "layers"], ["layers", "layers"])).toEqual(["color", "layers"]);
    expect(reorderVisible(["color", "layers"], ["unknown"])).toEqual(["color", "layers"]);
  });
});

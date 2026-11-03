import { describe, expect, it } from "vitest";
import { createCharacterSchema } from "../server/characters";

const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

describe("character create input", () => {
  it("accepts one to sixteen distinct references and normalizes the name", () => {
    const parsed = createCharacterSchema.parse({
      idempotencyKey: "create-1",
      name: "  Ada  ",
      referenceAssetIds: [uuid(1), uuid(2)],
    });
    expect(parsed).toEqual({
      idempotencyKey: "create-1",
      name: "Ada",
      description: "",
      referenceAssetIds: [uuid(1), uuid(2)],
    });
    expect(createCharacterSchema.safeParse({
      idempotencyKey: "create-2",
      name: "Ada",
      referenceAssetIds: Array.from({ length: 16 }, (_, index) => uuid(index + 1)),
    }).success).toBe(true);
  });

  it("rejects duplicates, empty packs, oversized packs and client provenance", () => {
    const base = { idempotencyKey: "create-1", name: "Ada" };
    expect(createCharacterSchema.safeParse({ ...base, referenceAssetIds: [] }).success).toBe(false);
    expect(createCharacterSchema.safeParse({ ...base, referenceAssetIds: [uuid(1), uuid(1)] }).success).toBe(false);
    expect(createCharacterSchema.safeParse({
      ...base,
      referenceAssetIds: Array.from({ length: 17 }, (_, index) => uuid(index + 1)),
    }).success).toBe(false);
    expect(createCharacterSchema.safeParse({
      ...base,
      referenceAssetIds: [uuid(1)],
      referencePack: { forged: true },
    }).success).toBe(false);
  });
});

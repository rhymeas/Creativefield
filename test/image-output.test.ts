import { describe, expect, it } from "vitest";
import type { HistoryEntry, OutputFile } from "../src/comfy/client";
import { assertSafeImageFile, imageOutputFiles } from "../server/image-output";

const file = (filename: string, subfolder = "ComfyField/images", type = "output"): OutputFile => ({ filename, subfolder, type });

describe("image history output discovery", () => {
  it("finds SaveImage batches in deterministic node and batch order", () => {
    const graph = {
      "10": { class_type: "SaveImage" },
      "2": { class_type: "SaveImageAdvanced" },
      "3": { class_type: "PreviewImage" },
    };
    const entry: HistoryEntry = {
      outputs: {
        "10": { images: [file("ten-a.png"), file("ten-b.png")] },
        "2": { images: [file("two-a.png"), file("two-b.png")], files: [file("ignored.png")] },
        "3": { images: [file("preview.png")] },
      },
    };
    expect(imageOutputFiles(graph, entry).map((item) => item.filename)).toEqual([
      "two-a.png",
      "two-b.png",
      "ten-a.png",
      "ten-b.png",
    ]);
  });

  it("does not discover unrelated arrays or malformed image entries", () => {
    const graph = { "1": { class_type: "SaveImage" }, "2": { class_type: "SaveVideo" } };
    const entry = {
      outputs: {
        "1": {
          images: [null, "x", { filename: "missing-fields.png" }, file("valid.png")],
          arbitrary: [file("not-an-image-output.png")],
        },
        "2": { images: [file("video-node.png")] },
      },
    } as unknown as HistoryEntry;
    expect(imageOutputFiles(graph, entry)).toEqual([file("valid.png")]);
  });
});

describe("worker image output path validation", () => {
  it("accepts a plain filename and nested relative subfolder", () => {
    expect(() => assertSafeImageFile(file("qwen_00001_.png"))).not.toThrow();
    expect(() => assertSafeImageFile(file("image.webp", ""))).not.toThrow();
  });

  it.each([
    file("../escape.png"),
    file("nested/escape.png"),
    file("nested\\escape.png"),
    file("%2e%2e.png"),
    file("CON.png"),
    file("trailing. "),
    file("temp.png", "ComfyField/images", "temp"),
    file("x.png", "../escape"),
    file("x.png", "ComfyField//images"),
    file("x.png", ["C:", "/fixture/untrusted"].join("")),
    file("x.png", "/absolute"),
    file("x.png", "\\\\server\\share"),
    file("x.png", "ComfyField/images/"),
    file("x.png", "ComfyField/%2e%2e"),
  ])("rejects unsafe worker path %#", (candidate) => {
    expect(() => assertSafeImageFile(candidate)).toThrow(/invalid worker output path/i);
  });
});

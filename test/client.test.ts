import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComfyClient, firstOutputFile, PromptRejectedError, type ComfyEvent } from "../src/comfy/client";
import { startMockComfy, type MockComfy } from "./mock-comfy";
import fixtureTemplate from "./fixtures/fixture_i2v_api.json";
import fixtureManifest from "./fixtures/fixture-manifest.json";
import { buildGraph, type ApiGraph } from "../src/workflow/build";
import type { Manifest } from "../src/workflow/manifest";

let mock: MockComfy;

beforeEach(async () => {
  mock = await startMockComfy({ outputNode: "6" });
});

afterEach(async () => {
  await mock.close();
});

describe("ComfyClient against a mock server", () => {
  it("uploads an image and returns the server filename", async () => {
    const client = new ComfyClient(mock.url);
    const name = await client.uploadImage(new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
    expect(name).toBe("upload.png");
  });

  it("submits a built graph and gets a prompt ID", async () => {
    const client = new ComfyClient(mock.url);
    const graph = buildGraph(
      fixtureTemplate as ApiGraph,
      fixtureManifest as Manifest,
      {
        prompt: "test",
        negative: "",
        startImage: "upload.png",
        resolution: "landscape",
        durationSec: 2,
        seed: 7,
      },
    );
    const promptId = await client.submitPrompt(graph);
    expect(promptId).toMatch(/^mock-/);
    expect(mock.lastGraph()).toMatchObject({ "5": { inputs: { length: 33 } } });
  });

  it("streams progress and completion over the socket, then serves the output", async () => {
    const client = new ComfyClient(mock.url);
    const events: ComfyEvent[] = [];
    let opened = false;
    const close = client.connect(
      (e) => events.push(e),
      (open) => (opened = open),
    );

    // Wait for the socket to open before submitting, so no events are missed.
    await waitFor(() => opened);

    const promptId = await client.submitPrompt(fixtureTemplate as ApiGraph);

    await waitFor(() => events.some((e) => e.type === "executing" && e.node === null));
    close();

    const mine = events.filter((e) => !e.promptId || e.promptId === promptId);
    expect(mine.some((e) => e.type === "progress" && e.value === 4 && e.max === 4)).toBe(true);
    expect(mine.some((e) => e.type === "executed" && e.node === "6")).toBe(true);

    const entry = await client.history(promptId);
    expect(entry?.status?.status_str).toBe("success");

    const file = firstOutputFile(entry?.outputs["6"]);
    expect(file).toEqual({ filename: "out_00001.mp4", subfolder: "video", type: "output" });
    expect(client.viewUrl(file!)).toContain("/view?filename=out_00001.mp4");

    const bytes = await fetch(client.viewUrl(file!));
    expect(await bytes.text()).toBe("fake-mp4-bytes");
  });
});

describe("ComfyClient errors and node definitions", () => {
  it("throws a PromptRejectedError that carries ComfyUI's node errors", async () => {
    const client = new ComfyClient(mock.url);
    const err = await client
      .submitPrompt({ "9": { class_type: "RejectMe", inputs: {} } })
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(PromptRejectedError);
    const rejected = err as PromptRejectedError;
    expect(rejected.status).toBe(400);
    expect(rejected.message).toBe("Prompt outputs failed validation");
    expect(rejected.rejection.node_errors["9"].errors[0].extra_info?.input_name).toBe("text");
  });

  it("fetches node definitions for only the classes asked for, and omits unknown ones", async () => {
    const client = new ComfyClient(mock.url);
    const info = await client.objectInfoFor(["KSampler", "KSampler", "MissingNode"]);
    expect(Object.keys(info)).toEqual(["KSampler"]);
  });
});

describe("firstOutputFile", () => {
  it("returns undefined when a node produced no files", () => {
    expect(firstOutputFile(undefined)).toBeUndefined();
    expect(firstOutputFile({ text: ["hello"] })).toBeUndefined();
  });
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

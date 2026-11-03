import { describe, expect, it } from "vitest";
import { sharpenRunBody } from "../src/team/sharpen-run";
import type { Run } from "../src/team/api";

const run: Run = {
  id: "run", project_id: "project", worker_id: "worker", created_by: "user", capability_id: "h3-i2v", capability_version: "1.0", state: "succeeded", error: null, output_ids: [], created_at: "", updated_at: "",
  invocation: { routeId: "local-h3", audioPolicy: "preserve", presetId: "preset", controls: { seed: 7, prompt: "scene", sharpen: false }, inputs: { source: "project-video", reference: "derived-asset" }, elementInputSnapshots: { reference: { validationVersion: 1, inputPort: "reference", elementId: "element", elementKind: "character", assetId: "original-asset", assetSha256: "a".repeat(64), assetMediaType: "image", assetProjectId: null } } },
};

describe("sharpen this take", () => {
  it("preserves the workflow, exact inputs and controls while enabling sharpen", () => {
    expect(sharpenRunBody(run, "new-attempt")).toMatchObject({ projectId: "project", workerId: "worker", idempotencyKey: "new-attempt", capabilityId: "h3-i2v", version: "1.0", routeId: "local-h3", audioPolicy: "preserve", presetId: "preset", inputs: { source: "project-video" }, elementInputs: { reference: { elementId: "element", assetId: "derived-asset" } }, controls: { seed: 7, prompt: "scene", sharpen: true } });
  });
  it("refuses to silently invent missing settings or reference bindings", () => {
    expect(() => sharpenRunBody({ ...run, invocation: { controls: {}, inputs: {} } }, "new-attempt")).toThrow("settings");
    expect(() => sharpenRunBody({ ...run, invocation: { ...run.invocation!, inputs: {} } }, "new-attempt")).toThrow("reference");
  });
});

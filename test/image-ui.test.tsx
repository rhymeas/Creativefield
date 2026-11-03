import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CapabilityManifestV2, Readiness } from "../src/capabilities/types";
import { createStartInputs, createStartTarget, ImageStudio, mergeImageRuns, toggleCreateReferenceSelection } from "../src/image/ImageStudio";
import { defaultImageDraft, handleImageStudioShortcut, imageDraftIssues } from "../src/image/image-state";

const manifest: CapabilityManifestV2 = {
  schemaVersion: 2,
  id: "image.qwen-2-1.t2i",
  version: "1.0.0",
  title: "Qwen Image 2.1 (local)",
  category: "t2i",
  description: "Local text-to-image workflow",
  inputs: [],
  outputs: [{ id: "image", label: "Image", type: "image", required: true }],
  controls: [
    { id: "prompt", label: "Prompt", type: "string", default: "A glass city at dawn", binding: { node: "1", field: "prompt" } },
    { id: "aspect_ratio", label: "Aspect ratio", type: "select", default: "1:1", options: ["1:1", "16:9"], binding: { node: "2", field: "aspect_ratio" } },
    { id: "seed", label: "Seed", type: "integer", default: 42, min: 0, binding: { node: "3", field: "seed" } },
    { id: "unbound", label: "Internal value", type: "string", default: "hidden" },
  ],
  presets: [],
  routes: [{ id: "local", execution: "local_comfy", provider: "ComfyUI", upstreamProviders: [], implementation: "implemented", workflowId: "qwen-image-2-1", requirements: [], evidence: [] }],
  coverage: { local: "implemented", hosted: "planned" },
  licenses: { software: "MIT", weights: [] },
  sources: [],
  tickets: [],
  audioPolicies: ["mute"],
};

const ready: Readiness = { state: "ready", reasons: [], missing: [] };
const baseProps = {
  workspace: { id: "workspace-1", name: "Studio", role: "creator" as const },
  project: { id: "project-1", name: "Campaign stills" },
  manifest,
  readiness: ready,
  assets: [],
  runs: [],
  draft: defaultImageDraft(manifest),
  onDraftChange: vi.fn(),
  onGenerate: vi.fn(),
};

describe("Image Studio", () => {
  const liveRun = (state: string) => ({ id: "run-live", project_id: "project-1", created_by: "user-1", capability_id: manifest.id,
    capability_version: manifest.version, state, error: state === "failed" ? "Worker fixture failed" : null,
    output_ids: [], created_at: "2026-10-21T00:00:00Z", updated_at: "2026-10-21T00:00:01Z" });

  it("includes discovered angle runs and prefers their newer server state",()=>{
    const listed=liveRun("running"),newer={...listed,state:"succeeded",updated_at:"2026-10-21T00:00:02Z"};
    const extra={...liveRun("queued"),id:"angle-2"};
    expect(mergeImageRuns([listed],[newer,extra],manifest.id).map(run=>[run.id,run.state])).toEqual([["run-live","succeeded"],["angle-2","queued"]]);
    expect(mergeImageRuns([newer],[listed],manifest.id)[0].state).toBe("succeeded");
  });

  it("routes a multi-file Create start into the capable Fibo reference ports",()=>{
    const models=[{value:"flux2-klein-edit",label:"Flux edit"},{value:"fibo2-edit",label:"Fibo edit"}];
    expect(createStartTarget(1,models)).toBe("fibo2-edit");
    expect(createStartTarget(4,models)).toBe("fibo2-edit");
    expect(createStartTarget(2,models.slice(0,1))).toBeNull();
    expect(createStartInputs(["source","ref-a","ref-b","ref-c","ignored"])).toEqual({
      source_image:"source",reference_image:"ref-a",reference_image_2:"ref-b",reference_image_3:"ref-c",
    });
  });

  it("keeps ordered Library selection bounded to four images",()=>{
    expect(toggleCreateReferenceSelection(["a","b"],"c")).toEqual(["a","b","c"]);
    expect(toggleCreateReferenceSelection(["a","b"],"a")).toEqual(["b"]);
    expect(toggleCreateReferenceSelection(["a","b","c","d"],"e")).toEqual(["a","b","c","d"]);
  });

  it("advertises a real multi-file picker only when both edit models are available",()=>{
    const html=renderToStaticMarkup(<ImageStudio {...baseProps}
      modelOptions={[{value:manifest.id,label:manifest.title},{value:"flux2-klein-edit",label:"Flux edit"},{value:"fibo2-edit",label:"Fibo edit"}]}
      onModel={()=>{}} batchContext={{userId:"user-1",workerId:"worker-1",call:vi.fn(),onChanged:vi.fn()}}
    />);
    expect(html).toContain("Add a picture or up to 3 references");
    expect(html).toContain("Drop, paste or choose 1–4 files from this device");
    expect(html).toContain("Choose from library");
  });

  it("exposes authorized cancellation only until it has been requested", () => {
    const props = { ...baseProps, onCancel: vi.fn(), canCancelRun: () => true };
    const running = renderToStaticMarkup(<ImageStudio {...props} runs={[liveRun("running")]} />);
    expect(running).toContain(">Cancel</button>");
    const requested = renderToStaticMarkup(<ImageStudio {...props} runs={[liveRun("cancel_requested")]} />);
    expect(requested).toContain("Cancelling…");
    expect(requested).not.toContain(">Cancel</button>");
    const otherOwner = renderToStaticMarkup(<ImageStudio {...props} canCancelRun={() => false} runs={[liveRun("running")]} />);
    expect(otherOwner).not.toContain(">Cancel</button>");
  });

  it("keeps the main action animated for the full active run", () => {
    for (const state of ["pending", "queued", "running", "cancel_requested"]) {
      const html=renderToStaticMarkup(<ImageStudio {...baseProps} runs={[liveRun(state)]}/>);
      expect(html).toContain("Generating…");
      expect(html).toContain("ds-sparkle");
      expect(html).toMatch(/<button[^>]*class="ds-generate"[^>]*disabled/);
    }
    expect(renderToStaticMarkup(<ImageStudio {...baseProps} runs={[liveRun("succeeded")]}/>)).toContain("Generate image");
  });

  it("shows a terminal failure with real recovery actions and no live waiting state", () => {
    const html = renderToStaticMarkup(<ImageStudio {...baseProps} onRetake={vi.fn()} runs={[liveRun("failed")]} />);
    expect(html).toContain("Image generation failed");
    expect(html).toContain("Worker fixture failed");
    expect(html).toContain(">Retake</button>");
    expect(html).toContain(">Details</button>");
    expect(html).not.toContain('aria-busy="true"');
  });

  it("does not render an empty result card for a completed run without an image file", () => {
    const html = renderToStaticMarkup(<ImageStudio {...baseProps} runs={[liveRun("succeeded")]} />);
    expect(html).not.toContain("Generated images");
    expect(html).not.toContain("ds-resultgrid");
    expect(html).not.toContain("Images of run run-live");
  });

  it("shows a loading result for an active generation without inventing a finished image",()=>{
    const html=renderToStaticMarkup(<ImageStudio {...baseProps} runs={[liveRun("running")]}/>);
    expect(html).toContain('aria-label="Generated images" data-count="1"');
    expect(html).toContain('data-develop=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('alt="run-live"');
  });

  it("offers cancellation on an authorized running result card",()=>{
    const html=renderToStaticMarkup(<ImageStudio {...baseProps} runs={[liveRun("running")]} onCancel={vi.fn()} canCancelRun={()=>true}/>);
    const tile=html.match(/<div class="cf-run-develop">[\s\S]*?<\/div><\/div>/)?.[0]??"";
    expect(tile).toContain(">Cancel</button>");
    const restricted=renderToStaticMarkup(<ImageStudio {...baseProps} runs={[liveRun("running")]} onCancel={vi.fn()} canCancelRun={()=>false}/>);
    expect(restricted).not.toContain(">Cancel</button>");
  });

  it("renders the established DS surfaces, bound controls and no empty result grid", () => {
    const html = renderToStaticMarkup(<ImageStudio {...baseProps} />);
    expect(html).toContain('class="cf-image-studio"');
    expect(html).toContain("ds-panel");
    expect(html).toContain("ds-modelcard");
    expect(html).toContain("Local ComfyUI");
    expect(html).toContain("ds-prompt");
    expect(html).toContain("ds-canvas");
    expect(html).toContain("Generate image");
    expect(html).toContain("Advanced settings");
    expect(html).not.toContain("Aspect ratio");
    expect(html).not.toContain("Internal value");
    expect(html).not.toContain("ds-resultgrid");
  });

  it("keeps the action visible and names the truthful disabled reason", () => {
    const draft = { controls: { ...baseProps.draft.controls, prompt: "" } };
    const html = renderToStaticMarkup(<ImageStudio {...baseProps} draft={draft} />);
    expect(imageDraftIssues(manifest, draft)).toContain("Describe the image before generating.");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Describe the image before generating.");
    expect(html).not.toMatch(/<button[^>]*class="ds-generate"[^>]*\sdisabled(?:=|\s|>)/);
  });

  it("runs Ctrl+Enter only when generation is enabled", () => {
    const generate = vi.fn();
    const preventDefault = vi.fn();
    const event = { key: "Enter", ctrlKey: true, metaKey: false, preventDefault };
    expect(handleImageStudioShortcut(event, true, generate)).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(handleImageStudioShortcut(event, false, generate)).toBe(false);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("renders image results as one gallery without a separate history mode", () => {
    const assets=[
      { id: "asset-2", project_id: "project-1", name: "new-city.png", media_type: "image", content_type: "image/png", sha256: "def", bytes: "2048", created_at: "2026-10-17T00:00:00.000Z", parent_id: null },
      { id: "asset-1", project_id: "project-1", name: "city.png", media_type: "image", content_type: "image/png", sha256: "abc", bytes: "2048", created_at: "2026-10-16T00:00:00.000Z", parent_id: null },
    ];
    const html = renderToStaticMarkup(
      <ImageStudio
        {...baseProps}
        assets={assets}
        runs={[
          { id: "run-2", project_id: "project-1", created_by: "user-1", capability_id: manifest.id, capability_version: manifest.version, state: "succeeded", error: null, output_ids: ["asset-2"], created_at: "2026-10-17T00:00:00.000Z", updated_at: "2026-10-17T00:00:01.000Z", invocation: { controls: { prompt: "A newer city" }, inputs: {} } },
          { id: "run-1", project_id: "project-1", created_by: "user-1", capability_id: manifest.id, capability_version: manifest.version, state: "succeeded", error: null, output_ids: ["asset-1"], created_at: "2026-10-16T00:00:00.000Z", updated_at: "2026-10-16T00:00:01.000Z", invocation: { controls: { prompt: "A glass city at dawn" }, inputs: {} } },
        ]}
      />,
    );
    expect(html).toContain("city.png");
    expect(html).toContain("new-city.png");
    expect(html).toContain('class="ds-resultgrid"');
    expect(html).toContain('aria-label="Generated images" data-count="2"');
    expect(html).not.toContain("History ·");
    expect(html).not.toContain("ds-collapsible");
    expect(html).toContain("/api/v1/workspaces/workspace-1/assets/asset-1/content");
    const resultBlock = html.match(/<section class="ds-block" aria-label="Generated images">[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(resultBlock).not.toContain("<video");
    expect(resultBlock.match(/class="ds-resulttile"[^>]*draggable="true"/g)).toHaveLength(2);
    expect(resultBlock.match(/<img draggable="false"[^>]*alt="(?:new-city|city)\.png"/g)).toHaveLength(2);
  });
});

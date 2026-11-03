import { describe, expect, it } from "vitest";
import { providers, providersFor } from "../src/pipelines/registry";
import { matchProvider, readParams } from "../src/pipelines/recover";
import { buildGraph } from "../src/workflow/build";
import { jobFromHistory } from "../src/jobs/server";
import { MOTION_MAX_CLIP_SECONDS, motionClipNotice } from "../src/team/TeamComposer";
import { WAN_ANIMATE_MAX_DESIRED_FRAMES } from "../src/capabilities/motion";
import type { HistoryEntry } from "../src/comfy/client";

const motion = providersFor("motion").find((p) => p.id === "wan-animate2-distilled")!;
const base = {
  prompt: "Character appearance: an astronaut. Background: a plain studio.",
  negative: "",
  motionPrompt: "a person dancing",
  resolution: "portrait",
  durationSec: 0,
  seed: 12,
};

describe("motion-control provider", () => {
  it("is found in the motion pipeline, with its own family", () => {
    expect(motion).toBeDefined();
    expect(motion.pipeline).toBe("motion");
    expect(motion.manifest.family).toBe("wan-animate2");
  });

  it("has a motion video and a motion prompt, and no length", () => {
    expect(motion.manifest.inputs.motion_video?.node).toBe("240");
    expect(motion.manifest.inputs.motion_prompt?.node).toBe("604");
    expect(motion.manifest.inputs.length).toBeUndefined();
  });

  it("writes the character, the driving video, both prompts, the size, and the seed", () => {
    const g = buildGraph(motion.template, motion.manifest, { ...base, startImage: "char.png", motionVideo: "drive.mp4" });
    expect(g["189"].inputs.image).toBe("char.png");
    expect(g["240"].inputs.file).toBe("drive.mp4");
    expect(g["605"].inputs.value).toBe(base.prompt);
    expect(g["604"].inputs.value).toBe("a person dancing");
    expect(g["261:243"].inputs).toMatchObject({ "resize_type.width": 480, "resize_type.height": 848 });
    expect(g["261:19"].inputs.noise_seed).toBe(12);
  });

  it("states the fps and sizes the model really writes", () => {
    expect(motion.manifest.limits.fps).toBe(24);
    expect(motion.manifest.limits.resolutions).toEqual({
      portrait: { width: 480, height: 848 },
      landscape: { width: 848, height: 480 },
    });
  });

  it("builds without a duration, because the template fixes the length at 81 frames", () => {
    const g = buildGraph(motion.template, motion.manifest, { ...base, durationSec: 99, startImage: "c.png", motionVideo: "d.mp4" });
    expect(g["261:247"].inputs.length).toBe(81);
  });

  it("keeps the template's own motion text when none is given", () => {
    const g = buildGraph(motion.template, motion.manifest, { ...base, motionPrompt: "  ", startImage: "c.png", motionVideo: "d.mp4" });
    expect(String(g["604"].inputs.value).length).toBeGreaterThan(5);
  });

  it("refuses to build without the driving video or the character image", () => {
    expect(() => buildGraph(motion.template, motion.manifest, { ...base, startImage: "c.png" })).toThrow(/motion video/);
    expect(() => buildGraph(motion.template, motion.manifest, { ...base, motionVideo: "d.mp4" })).toThrow(/start image/);
  });

  it("has the comparison output and the frame-count preview left out of the template", () => {
    const classes = Object.values(motion.template).map((n) => n.class_type);
    expect(classes).not.toContain("ImageStitch");
    expect(classes).not.toContain("PreviewAny");
    expect(Object.values(motion.template).filter((n) => n.class_type === "SaveVideo")).toHaveLength(1);
  });

  it("uses the installed VAE rather than a file that would need downloading", () => {
    expect(motion.template["261:7"].inputs.vae_name).toBe("wan_2.1_vae.safetensors");
  });
});

describe("motion clip length", () => {
  it("keeps a clip at the 641-frame cap and warns only above it", () => {
    expect(WAN_ANIMATE_MAX_DESIRED_FRAMES / 24).toBe(MOTION_MAX_CLIP_SECONDS);
    expect(motionClipNotice(WAN_ANIMATE_MAX_DESIRED_FRAMES / 24)).toBeNull();
    expect(motionClipNotice((WAN_ANIMATE_MAX_DESIRED_FRAMES + 1) / 24)).toBe(
      "This clip is too long. Use up to 26 seconds.",
    );
  });

  it("rounds the longest clip down to whole seconds for the drop zone", () => {
    expect(Math.floor(MOTION_MAX_CLIP_SECONDS)).toBe(26);
  });

  it("stays quiet until the chosen clip has been measured", () => {
    expect(motionClipNotice(null)).toBeNull();
    expect(motionClipNotice(Number.NaN)).toBeNull();
  });
});

describe("recovering a motion-control job", () => {
  it("reads every parameter back and tells the graph apart from the other pipelines", () => {
    const g = buildGraph(motion.template, motion.manifest, { ...base, startImage: "char.png", motionVideo: "drive.mp4" });
    expect(matchProvider(g, providers)?.id).toBe("wan-animate2-distilled");
    expect(readParams(g, motion.manifest)).toMatchObject({
      prompt: base.prompt,
      motionPrompt: "a person dancing",
      startImage: "char.png",
      motionVideo: "drive.mp4",
      aspect: "portrait",
      durationSec: 0,
      seed: 12,
    });
  });

  it("builds a history card with the character and the driving video", () => {
    const g = buildGraph(motion.template, motion.manifest, { ...base, startImage: "char.png", motionVideo: "drive.mp4" });
    const entry: HistoryEntry = {
      prompt: [1, "job", g, { create_time: 1 }, ["246"]],
      outputs: { "246": { images: [{ filename: "v.mp4", subfolder: "video", type: "output" }] } },
      status: { status_str: "success", messages: [] },
    };
    expect(jobFromHistory("job", entry, providers)).toMatchObject({
      providerId: "wan-animate2-distilled",
      status: "done",
      thumb: { kind: "input", filename: "char.png" },
      motionThumb: { kind: "input", filename: "drive.mp4" },
      params: { motionPrompt: "a person dancing" },
    });
  });
});

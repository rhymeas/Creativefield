import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileLocal } from "../src/capabilities/compile";
import {compileScailChunks,planScailChunks} from "../src/capabilities/replace";
import { assertLocalGraphPolicy } from "../src/capabilities/policy";
import type { CapabilityBundle, CapabilityManifestV2, Invocation } from "../src/capabilities/types";
import { validateCapability } from "../src/capabilities/validate";
import type { ApiGraph } from "../src/workflow/build";

const root = "native-workflows/scail2-character-replace";
const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, "utf8")) as CapabilityManifestV2;
const template = JSON.parse(readFileSync(`${root}/template.api.json`, "utf8")) as ApiGraph;
const bundle: CapabilityBundle = { manifest, template };

/** A graph link, `[node, output]`. */
const link = (value: unknown): [string, number] | undefined =>
  Array.isArray(value) && typeof value[0] === "string" ? (value as [string, number]) : undefined;
const sources = (node: string, field: string) => link(template[node].inputs[field])?.[0];

/** The length the graph hands WanSCAILToVideo: GetImageSize of the first 81 resized frames, so a
 *  clip of 81 frames or fewer keeps its own frame count instead of being padded up to 81. */
function lengthFor(frames: number): number {
  expect(sources("213:177", "image"), "the size probe slices the resized clip").toBe("213:156");
  expect(sources("213:163", "image"), "the window is measured from the size probe").toBe("213:177");
  expect(sources("213:114", "length"), "length reads the measured size").toBe("213:163");
  const cap = template["213:177"].inputs.length;
  expect(typeof cap).toBe("number");
  return Math.min(frames, Number(cap));
}

/** What one WanSCAILToVideo pass renders from a clip of `frames` frames: the pose window is cut at the
 *  smaller of the pose frames and length, rounded down to 4n+1; the latent has one frame per four. */
function passFor(frames: number) {
  const poseFrames = sources("213:114", "pose_video") === "213:156" ? frames : Math.min(frames, 81);
  const length = lengthFor(frames);
  const offset = Number(template["213:114"].inputs.video_frame_offset);
  const kept = (Math.floor((Math.min(poseFrames - offset, length) - 1) / 4) * 4) + 1;
  const latents = Math.floor((length - 1) / 4) + 1;
  return { length, poseFrames, kept, latents, outputFrames: 4 * (latents - 1) + 1 };
}

const run = (inputs: Record<string, string>, controls: Record<string, string | number | boolean> = {}): ApiGraph =>
  compileLocal(bundle, {
    capabilityId: manifest.id, version: manifest.version, routeId: "local",
    inputs: { source_video: "comfyfield-clip.mp4", ...inputs }, controls, audioPolicy: "mute",
  } satisfies Invocation);

describe("SCAIL-2 character replace template", () => {
  it("keeps the whole clip in the pose stream and only measures the window from the cap", () => {
    expect(sources("213:900", "input")).toBe("213:157");
    expect(sources("213:114", "pose_video")).toBe("213:156");
    expect(template["213:177"].inputs.length).toBe(81);
    expect(template["213:114"].inputs).not.toHaveProperty("previous_frames");
    expect(template["213:114"].inputs.video_frame_offset).toBe(0);
    expect(template["213:114"].inputs.previous_frame_count).toBe(5);
  });

  it("gives a clip of 81 frames or fewer exactly the frames it gave before", () => {
    for (let frames = 1; frames <= 81; frames += 1) {
      // Before the window moved, length was the same capped size, so the output is unchanged.
      expect(passFor(frames).outputFrames, `${frames} frames`).toBe(Math.floor((frames - 1) / 4) * 4 + 1);
      expect(passFor(frames).kept, `${frames} frames`).toBe(passFor(frames).outputFrames);
    }
    // A constant 81 window would render 81 frames here, 24 of them without pose.
    expect(passFor(60).outputFrames).toBe(57);
    expect(passFor(81).outputFrames).toBe(81);
  });

  it("still stops at 81 frames for a longer clip", () => {
    expect(passFor(96)).toMatchObject({ length: 81, poseFrames: 96, kept: 81, outputFrames: 81 });
    expect(passFor(1200).outputFrames).toBe(81);
  });

  it("bumps the revision for the one reference frame and still compiles", () => {
    expect(manifest.version).toBe("0.5.1");
    expect(validateCapability(bundle)).toEqual([]);
    expect(() => assertLocalGraphPolicy(template)).not.toThrow();
    const graph = run({ character_image: "comfyfield-face.png" });
    expect(graph["213:114"].inputs.length).toEqual(["213:163", 2]);
    expect(graph["213:114"].inputs.video_frame_offset).toBe(0);
  });

  it("cuts the character out at the frame's shape before WanSCAILToVideo crops it", () => {
    // WanSCAILToVideo upscales reference_image to (width,height) with a centre crop, so the picture
    // has to arrive already cut to the person at that shape, with the mask cut the same way.
    expect(link(template["213:114"].inputs.reference_image)).toEqual(["342", 0]);
    expect(link(template["213:114"].inputs.reference_image_mask)).toEqual(["343", 0]);
    expect(sources("213:225", "images")).toBe("30");
    expect(sources("213:225", "masks")).toBe("213:224");
    expect(template["213:225"].inputs.width).toEqual(["213:163", 0]);
    expect(template["213:225"].inputs.height).toEqual(["213:163", 1]);
    expect(sources("213:224", "track_data")).toBe("213:198");
    expect(template["213:224"].inputs.object_indices).toBe("0");
    expect(sources("213:227", "images")).toBe("213:226");
    expect(sources("213:227", "masks")).toBe("213:224");
    expect(sources("213:228", "image")).toBe("213:227");
    expect(sources("213:199", "ref_track_data")).toBe("213:228");
    // CLIP vision reads the same picture the model does.
    expect(sources("213:76", "image")).toBe("342");
  });

  it("keeps the reviewed single view for one character", () => {
    // The switch is the guard: batching the same picture twice confused the model (bffacdb8).
    expect(template["344"].class_type).toBe("PrimitiveBoolean");
    expect(template["344"].inputs.value).toBe(false);
    for (const id of ["342", "343"]) {
      expect(sources(id, "switch")).toBe("344");
      expect(link(template[id].inputs.on_false)).toEqual(id === "342" ? ["213:225", 0] : ["213:199", 1]);
    }

    const one = run({ character_image: "comfyfield-face.png" });
    expect(one["342"].inputs.on_false).toEqual(["213:225", 0]);
    expect(one["344"].inputs.value).toBe(false);
    // Nothing loads the second picture, so the second branch is never executed.
    expect(one["330"].inputs.image).toBe("");

    const two = run({ character_image: "comfyfield-face.png", character_image_2: "comfyfield-second.png" },
      { person: "0,1", two_people: true });
    expect(two["330"].inputs.image).toBe("comfyfield-second.png");
    expect(two["344"].inputs.value).toBe(true);
    expect(two["213:197"].inputs.object_indices).toBe("0,1");
  });

  it("holds both people in ONE reference frame, each at half the frame's width", () => {
    // Two separate frames are read as one identity with extra views, which mixes both faces onto
    // both people (run 6ede1bb6). One frame holding both is the node's own design (prompt 9313c646).
    expect(link(template["342"].inputs.on_true)).toEqual(["350", 0]);
    expect(link(template["343"].inputs.on_true)).toEqual(["353", 0]);

    // Half the frame's width, from the frame the model renders.
    expect(template["348"].class_type).toBe("ComfyMathExpression");
    expect(template["348"].inputs.expression).toBe("a / 2");
    expect(link(template["348"].inputs["values.a"])).toEqual(["213:163", 0]);

    // Each picture is cut out for its half: the first at the frame's left, the second at x = half.
    expect(template["346"].inputs).toMatchObject({ images: ["30", 0], masks: ["213:224", 0], width: ["348", 1], height: ["213:163", 1] });
    expect(template["347"].inputs).toMatchObject({ images: ["330", 0], masks: ["332", 0], width: ["348", 1], height: ["213:163", 1] });
    expect(template["337"].class_type).toBe("EmptyImage");
    expect(template["337"].inputs).toMatchObject({ width: ["213:163", 0], height: ["213:163", 1], batch_size: 1, color: 0 });
    expect(template["340"].inputs).toMatchObject({ destination: ["337", 0], source: ["346", 0], x: 0, y: 0 });
    expect(template["341"].inputs).toMatchObject({ destination: ["340", 0], source: ["347", 0], x: ["348", 1], y: 0 });

    // That one frame is what is tracked, cropped at the frame's shape and painted in two colours.
    expect(sources("345", "images")).toBe("341");
    expect(sources("345", "model")).toBe("213:193");
    expect(sources("349", "track_data")).toBe("345");
    expect(template["349"].inputs.object_indices).toBe("0,1");
    expect(template["350"].inputs).toMatchObject({ images: ["341", 0], masks: ["349", 0], width: ["213:163", 0], height: ["213:163", 1] });
    expect(template["352"].class_type).toBe("SCAIL2ColoredMask");
    expect(template["352"].inputs).toMatchObject({ driving_track_data: ["213:196", 0], ref_track_data: ["345", 0], object_indices: "0,1", sort_by: "left_to_right" });
    expect(template["353"].inputs).toEqual({...template["350"].inputs,images:["352",1]});
  });

  it("refuses a coloured mask that no longer shares the image crop",()=>{
    const changed=structuredClone(template);
    changed["213:114"].inputs.length=81;
    changed["353"].inputs.pad_factor=1.8;
    expect(()=>compileScailChunks(changed,planScailChunks(81))).toThrow("same crop geometry");
  });

  it("pins the graph the 0.5.1 revision names", () => {
    // The pinned hash moves with the graph in the same commit as the version bump, so a lost link shows up here.
    const canonical = readFileSync(`${root}/template.api.json`, "utf8").replaceAll("\r\n", "\n");
    expect(createHash("sha256").update(canonical).digest("hex"))
      .toBe("9b250e274fd475d278f4d89b252020f8a0a24f70545934a0c0945ee452d30d02");
  });
});

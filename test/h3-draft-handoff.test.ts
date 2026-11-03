import {readFileSync} from "node:fs";
import {describe,it,expect} from "vitest";
import type {CapabilityManifestV2} from "../src/capabilities/types";
import {restoreDraft} from "../src/team/state";
const manifest=JSON.parse(readFileSync("native-workflows/h3-i2v/manifest.json","utf8")) as CapabilityManifestV2;
describe("H3 image handoff draft",()=>{
  it("preserves the prompt, camera choice and other settings while replacing the start image",()=>{
    const original={controls:{prompt:"A slow dolly through the scene",seed:123},inputs:{start_image:"old"},elementInputs:{},cameraMove:"pan-left",audioPolicy:manifest.audioPolicies[0]};
    const draft=restoreDraft(manifest,original);
    draft.inputs.start_image="new";
    expect(draft.controls.prompt).toBe(original.controls.prompt);
    expect(draft.controls.seed).toBe(123);
    expect(draft.cameraMove).toBe("pan-left");
    expect(draft.audioPolicy).toBe(original.audioPolicy);
    expect(draft.inputs.start_image).toBe("new");
    expect(original.inputs.start_image).toBe("old");
  });
  it("ignores settings and ports no longer offered by the workflow",()=>{
    const draft=restoreDraft(manifest,{controls:{removed:1},inputs:{removed:"old"},elementInputs:{removed:{elementId:"e",assetId:"a"}},presetId:"invalid",audioPolicy:"invalid"});
    expect(draft.controls).not.toHaveProperty("removed");expect(draft.inputs).not.toHaveProperty("removed");expect(draft.elementInputs).not.toHaveProperty("removed");expect(draft.presetId).toBeUndefined();expect(manifest.audioPolicies).toContain(draft.audioPolicy);
  });
});

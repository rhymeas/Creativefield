import { describe, expect, it } from "vitest";
import upstream from "../native-workflows/openjutsu-h3-advanced/upstream.api.json";
import { prepareOpenJutsuAdvancedCharacters } from "../src/capabilities/openjutsu-advanced";
import manifest from "../native-workflows/openjutsu-h3-advanced/manifest.json";
import template from "../native-workflows/openjutsu-h3-advanced/template.api.json";
import {compileLocal} from "../src/capabilities/compile";
import {validateCapability} from "../src/capabilities/validate";
import {assertLocalGraphPolicy} from "../src/capabilities/policy";
import type {CapabilityBundle, Invocation} from "../src/capabilities/types";

describe("OpenJutsu advanced character branches", () => {
  for (const count of [1, 2, 3, 4]) it(`keeps exactly ${count} uploaded characters without dangling links`, () => {
    const graph = prepareOpenJutsuAdvancedCharacters(upstream, Array.from({ length: count }, (_, i) => `uploaded-${i + 1}.png`));
    const loaders = ["2", "5", "8", "11"], describes = ["4", "7", "10", "13"];
    for (let i = 0; i < 4; i++) {
      expect(Boolean(graph[loaders[i]])).toBe(i < count);
      expect(Boolean(graph[describes[i]])).toBe(i < count);
      if (i < count) expect(graph[loaders[i]].inputs.image).toBe(`uploaded-${i + 1}.png`);
      else {
        expect(graph["20"].inputs).not.toHaveProperty(`picture_${i + 1}`);
        expect(graph["20"].inputs).not.toHaveProperty(`picture_${i + 1}_text`);
        expect(Object.keys(graph["65"].inputs)).not.toContain(`ref_images.ref_image_${i}`);
      }
    }
    for (const node of Object.values(graph)) for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isInteger(value[1])) expect(graph[value[0]]).toBeDefined();
    }
    expect(upstream["8"].inputs.image).toBe("example.png");
  });

  it("preserves role ordering, normalizes role text and supplies upstream defaults", () => {
    const graph = prepareOpenJutsuAdvancedCharacters(upstream, ["a.png", "b.png"], ["  left   person ", ""]);
    expect(graph["20"].inputs.roles).toBe("left person\nthe person with the second most screen time");
    expect(prepareOpenJutsuAdvancedCharacters(upstream, ["a.png"])["20"].inputs.roles).toBe("");
  });

  it("rejects unsupported counts and unexpected connections to an omitted branch", () => {
    expect(() => prepareOpenJutsuAdvancedCharacters(upstream, [])).toThrow("one to four");
    expect(() => prepareOpenJutsuAdvancedCharacters(upstream, ["a", "b", "c", "d", "e"])).toThrow("one to four");
    const changed = structuredClone(upstream) as Record<string, {class_type:string;inputs:Record<string,unknown>;_meta?:{title?:string}}>;
    changed["20"].inputs.unexpected = ["5", 0];
    expect(() => prepareOpenJutsuAdvancedCharacters(changed, ["a"])).toThrow("Unexpected link");
  });

  it("rejects dangling or invalid links before submitting the graph", () => {
    const changed = structuredClone(upstream) as Record<string, {class_type:string;inputs:Record<string,unknown>;_meta?:{title?:string}}>;
    changed["20"].inputs.source_frames = ["missing", 0];
    expect(() => prepareOpenJutsuAdvancedCharacters(changed, ["a"])).toThrow("Invalid workflow link at 20.source_frames");
    changed["20"].inputs.source_frames = ["14", -1];
    expect(() => prepareOpenJutsuAdvancedCharacters(changed, ["a"])).toThrow("Invalid workflow link at 20.source_frames");
  });
});

describe("experimental OpenJutsu advanced pack", () => {
  const bundle = {manifest, template} as unknown as CapabilityBundle;
  const invocation = (count:number):Invocation => ({capabilityId:manifest.id,version:manifest.version,routeId:"local",inputs:{source_video:"comfyfield-source.mp4",...Object.fromEntries(Array.from({length:count},(_,i)=>[i ? `reference_image_${i+1}` : "reference_image",`comfyfield-character-${i+1}.png`]))},controls:{roles: count > 1 ? "left person\nright person" : "",window_seconds:6,resolution:"736p",seed:17},audioPolicy:"preserve"});
  it("registers valid metadata without claiming a qualified route", () => {
    expect(validateCapability(bundle)).toEqual([]);
    expect(manifest.routes[0].implementation).toBe("experimental");
  });
  it("does not allow experimental role nodes in ordinary local graphs", () => {
    expect(() => assertLocalGraphPolicy({ node: { class_type: "H3TrackRoles", inputs: {} } })).toThrow("Unreviewed or forbidden node");
    expect(() => compileLocal(bundle, invocation(1))).toThrow("Selected route is unavailable");
  });
  for (const count of [1,2,3,4]) it(`binds ${count} references through the real compiler`,()=>{
    const graph=compileLocal(bundle,invocation(count),{allowExperimental:true});
    expect(graph["14"].inputs.video).toBe("comfyfield-source.mp4");
    expect(graph["20"].inputs.seed).toBe(17);
    expect(graph["20"].inputs.roles).toBe(count>1?`left person\nright person${count>2?'\nthe person with the third most screen time':''}${count>3?'\nthe person with the fourth most screen time':''}`:"");
    expect(["2","5","8","11"].filter(id=>!!graph[id])).toHaveLength(count);
  });
  it("rejects sparse reference slots and missing first character",()=>{
    const sparse=invocation(3);delete sparse.inputs.reference_image_2;
    expect(()=>compileLocal(bundle,sparse,{allowExperimental:true})).toThrow("in order");
    const empty=invocation(0);
    expect(()=>compileLocal(bundle,empty,{allowExperimental:true})).toThrow("Missing asset");
  });
});

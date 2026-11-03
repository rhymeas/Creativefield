import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import type {CapabilityManifestV2} from "../src/capabilities/types";
import {defaultImageDraft} from "../src/image/image-state";
import {readSubjectRelight,subjectRelightInstruction,subjectRelightKey,subjectRelightSchema} from "../src/image/subject-relight";

const manifest:CapabilityManifestV2=JSON.parse(readFileSync("native-workflows/flux2-klein-relight/manifest.json","utf8"));
const scope={workspaceId:"00000000-0000-4000-8000-000000000001",projectId:"00000000-0000-4000-8000-000000000002",assetId:"00000000-0000-4000-8000-000000000003"};

describe("subject-only relight handoff",()=>{
  it("carries the selected mood, user note and light guide into the masked instruction",()=>{
    const draft={...defaultImageDraft(manifest),presetId:manifest.presets[0].id};
    draft.controls.prompt="Keep the striped jacket";
    const prompt=subjectRelightInstruction(manifest,draft,"from the left","Daylight");
    expect(prompt).toContain(manifest.presets[0].values.prompt);
    expect(prompt).toContain("Keep the striped jacket");
    expect(prompt).toContain("Light direction: from the left. Light temperature: Daylight.");
    expect(prompt).toContain("Relight only the selected subject");
    expect(draft.controls.prompt).toBe("Keep the striped jacket");
  });

  it("rejects malformed and differently scoped requests",()=>{
    const value=subjectRelightSchema.parse({version:1,...scope,prompt:"Relight the selected subject"}),raw=JSON.stringify(value);
    expect(readSubjectRelight(raw,scope)).toEqual(value);
    for(const field of ["workspaceId","projectId","assetId"] as const)expect(readSubjectRelight(raw,{...scope,[field]:"00000000-0000-4000-8000-000000000009"})).toBeNull();
    expect(readSubjectRelight("{",scope)).toBeNull();
    expect(readSubjectRelight(JSON.stringify({...value,version:2}),scope)).toBeNull();
    expect(readSubjectRelight(JSON.stringify({...value,prompt:" "}),scope)).toBeNull();
    expect(subjectRelightKey(scope.workspaceId,scope.projectId,scope.assetId)).not.toBe(subjectRelightKey(scope.workspaceId,"other",scope.assetId));
  });

});

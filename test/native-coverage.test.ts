import {describe,expect,it} from "vitest";
import {missingNativeTemplates,nativeTemplateIssues} from "../src/workflow/native-coverage";

describe("native workflow coverage",()=>{
  it("reports a template omitted from the loaded catalogue",()=>{
    expect(missingNativeTemplates(["video-trim","image-edit"],["video-trim"])).toEqual(["image-edit"]);
  });
  it("respects a focused check and does not duplicate an ID",()=>{
    expect(missingNativeTemplates(["missing","missing","other"],[],"missing")).toEqual(["missing"]);
    expect(missingNativeTemplates(["present","missing"],["present"],"present")).toEqual([]);
  });
  it("reports unidentified and duplicate templates instead of silently counting them",()=>{
    const records=[{folder:"missing",error:"missing manifest"},{folder:"invalid",id:42},{folder:"first",id:"edit"},{folder:"second",id:"edit"}];
    expect(nativeTemplateIssues(records)).toEqual([
      {id:"missing",reason:"missing manifest"},
      {id:"invalid",reason:"native template has no valid manifest id"},
      {id:"edit",reason:"duplicate native template id in first and second"},
    ]);
    expect(nativeTemplateIssues(records,"edit")).toEqual([{id:"edit",reason:"duplicate native template id in first and second"}]);
  });
});

import {describe,expect,it} from "vitest";
import {nativePartnerSchemas} from "../src/workflow/native-partner-schemas";

describe("native cloud schema selection",()=>{
  it("selects only reviewed modules required by the graph",()=>{
    expect(nativePartnerSchemas({a:{class_type:"KlingOmniProEditVideoNode",inputs:{}},b:{class_type:"ByteDance2ReferenceNodeV2",inputs:{}},c:{class_type:"LoadImage",inputs:{}}})).toEqual(["nodes_kling.py","nodes_bytedance.py"]);
    expect(nativePartnerSchemas({a:{class_type:"UnknownPartnerNode",inputs:{}}})).toEqual([]);
  });
});

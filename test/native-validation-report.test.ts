import {describe, expect, it} from "vitest";
import {nativeValidationExit,nativeValidationReasons, nativeValidationStatus} from "../src/workflow/native-validation-report";

describe("native ComfyUI validation reports", () => {
  it("identifies the node and the missing model", () => {
    expect(nativeValidationReasons({"19:14":{class_type:"LoadBackgroundRemovalModel",errors:[{message:"Value not in list",details:"birefnet.safetensors"}]}}))
      .toEqual(["LoadBackgroundRemovalModel #19:14: Value not in list: birefnet.safetensors"]);
  });
  it("reports structured errors even when ComfyUI omits the human-readable message", () => {
    expect(nativeValidationReasons({"7":{class_type:"LoadImage",errors:[{type:"required_input_missing"},{extra_info:{input_name:"image"}}]}}))
      .toEqual(["LoadImage #7: required_input_missing","LoadImage #7: Invalid input: image"]);
  });
  it("handles absent or malformed node details", () => {
    expect(nativeValidationReasons(null)).toEqual([]);
    expect(nativeValidationReasons({"1":{errors:[null,{}]}})).toEqual([]);
  });
  it("does not mark an accepted graph fully valid when an output was rejected", () => {
    expect(nativeValidationStatus(true, {"2":{errors:[{message:"missing input"}]}})).toBe("partial");
    expect(nativeValidationStatus(true, {})).toBe("ok");
    expect(nativeValidationStatus(true, undefined)).toBe("partial");
    expect(nativeValidationStatus(false, {})).toBe("FAIL");
  });
  it("only succeeds for a fully checked, pinned catalogue",()=>{
    const full={statuses:["ok"] as Array<"ok"|"partial"|"FAIL">,skipped:0,nodeImportFailures:0,filtered:false,coreOnly:false,revisionPinned:true,strictNodes:true,validatorExit:0};
    expect(nativeValidationExit(full)).toBe(0);
    expect(nativeValidationExit({...full,filtered:true})).toBe(2);
    expect(nativeValidationExit({...full,skipped:1})).toBe(2);
    expect(nativeValidationExit({...full,nodeImportFailures:1})).toBe(2);
    expect(nativeValidationExit({...full,statuses:["partial"]})).toBe(2);
    expect(nativeValidationExit({...full,statuses:["FAIL"]})).toBe(1);
    expect(nativeValidationExit({...full,revisionPinned:false})).toBe(2);
    expect(nativeValidationExit({...full,strictNodes:false})).toBe(2);
  });
});

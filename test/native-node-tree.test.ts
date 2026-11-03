import {describe,expect,it} from "vitest";
import {nativeNodeTreeHash} from "../src/workflow/native-node-tree";

describe("copied custom-node content pins",()=>{
  it("is stable and changes when node source changes",()=>{
    const first=nativeNodeTreeHash("test/fixtures/native-node-pin/first");
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(nativeNodeTreeHash("test/fixtures/native-node-pin/first")).toBe(first);
    expect(nativeNodeTreeHash("test/fixtures/native-node-pin/second")).not.toBe(first);
  });
});

import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {assertLocalGraphPolicy,assertPlainFormat} from "../src/capabilities/policy";

describe("StringFormat in a local graph",()=>{
  it("allows format texts that only name values",()=>{
    expect(()=>assertPlainFormat("1","Request: {a}\nWidth {b:>8} {{literal}} {c!r}")).not.toThrow();
  });
  it("refuses attribute or index access and linked format texts",()=>{
    expect(()=>assertPlainFormat("1","{a.__init__.__globals__}")).toThrow(/only name values/);
    expect(()=>assertPlainFormat("1","{a[0]}")).toThrow(/only name values/);
    expect(()=>assertPlainFormat("1","{0}")).toThrow(/only name values/);
    expect(()=>assertPlainFormat("1",["5",0])).toThrow(/literal format/);
    // Nested fields and escape tricks that a strip-then-match check misses.
    expect(()=>assertPlainFormat("1","{a:{b.__class__}}")).toThrow(/only name values/);
    expect(()=>assertPlainFormat("1","{{{a.__class__}}}")).toThrow(/only name values/);
    expect(()=>assertPlainFormat("1","{a!x}")).toThrow(/only name values/);
    expect(()=>assertPlainFormat("1","stray } brace")).toThrow(/only name values/);
    expect(()=>assertPlainFormat("1","open {a")).toThrow(/only name values/);
  });
  it("still admits the official FLUX 3 Klein edit graph",()=>{
    const graph=JSON.parse(readFileSync("native-workflows/flux2-klein-edit/template.api.json","utf8"));
    expect(()=>assertLocalGraphPolicy(graph)).not.toThrow();
  });
});

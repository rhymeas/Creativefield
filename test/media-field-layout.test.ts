import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";

const css=readFileSync("src/ds/components.css","utf8");

describe("media field layout",()=>{
  it("lets a media slot fill its column inside a drop target",()=>{
    // The base drop target centres its content, which shrinks the slot to the width of its text.
    // A target that holds a slot or a card only takes the drop, so the media keeps the whole column.
    const rule=css.split(/\r?\n/).find(line=>line.startsWith(".ds-droptarget:has("))??"";
    expect(rule).toContain("display: block");
    expect(rule).toContain("place-items: normal");
  });

  it("keeps the tall quiet library pill to its words (no glint, no fill), and changes no other pill",()=>{
    expect(css).toMatch(/\.ds-pill--quiet\.ds-pill--lg\s*\{\s*box-shadow:\s*none;\s*background:\s*none;?\s*\}/);
    // The quiet pill in its normal size keeps its glint.
    expect(css).not.toMatch(/\.ds-pill--quiet\s*\{[^}]*box-shadow:\s*none/);
  });
});

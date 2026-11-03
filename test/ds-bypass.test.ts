import {describe,expect,it} from "vitest";
import {auditDesignSystem} from "../scripts/ds-audit.mjs";

/* The design system is the one place a control or a look is defined. A screen uses its components; it does not
   build its own button, input or select, set colours, fonts or radii in its own CSS, or style an element inline.
   When this fails, use the component from src/ds (README rule 24) or add it there first, with a Showcase entry.
   The allowance below can only shrink: lower it when you remove one, never raise it. */
const ALLOWED_INLINE_STYLES:Record<string,number>={
  // The node editor's full-screen frame in the entry file: pure layout, no look.
  "src/main.tsx":1,
};

describe("the app uses the design system and does not rebuild it",()=>{
  const rows=auditDesignSystem();
  it("builds no raw button, input, select or textarea outside src/ds",()=>{
    expect(Object.entries(rows).filter(([,row])=>row.raw>0).map(([file,row])=>`${file}: ${row.raw}`)).toEqual([]);
  });
  it("sets no colour, font, radius, shadow or opacity in feature CSS",()=>{
    expect(Object.entries(rows).filter(([,row])=>row.look>0).map(([file,row])=>`${file}: ${row.look}`)).toEqual([]);
  });
  it("styles nothing inline beyond the listed layout exceptions",()=>{
    const over=Object.entries(rows).filter(([file,row])=>row.inline>(ALLOWED_INLINE_STYLES[file]??0)).map(([file,row])=>`${file}: ${row.inline}`);
    expect(over).toEqual([]);
  });
});

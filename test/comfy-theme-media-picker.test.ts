import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";

const css=readFileSync("server/comfy-theme.css","utf8");

describe("embedded ComfyUI media picker theme",()=>{
  it("keeps asset titles readable and the active filter high contrast",()=>{
    expect(css).toContain('[style*="grid-template-columns: repeat(4"]');
    expect(css).toContain("grid-template-columns: repeat(3, minmax(0, 1fr)) !important");
    expect(css).toContain("[data-virtual-grid-item] [data-pd-tooltip]");
    expect(css).toContain("color: var(--text-primary) !important");
    expect(css).toContain('button[class*="surface-selected"]');
    expect(css).toContain("--interface-menu-component-surface-selected: var(--accent) !important");
    expect(css).toContain("background: var(--accent) !important");
    expect(css).toContain("color: var(--text-on-accent) !important");
  });
});

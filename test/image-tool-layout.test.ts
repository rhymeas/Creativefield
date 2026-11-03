import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";

const studio=readFileSync("src/image/ImageStudio.tsx","utf8");
const batch=readFileSync("src/image/AngleBatchPanel.tsx","utf8");
const css=readFileSync("src/ds/components.css","utf8");
const imageCss=readFileSync("src/image/image.css","utf8");

describe("image tool layout",()=>{
  it("uses the standard upload plus Library row and two-column reference grids",()=>{
    expect(studio).toContain('>Choose from library</Button>');
    expect(studio).toContain('visibleImageInputs.length>1?"cf-image-input-grid":"cf-image-input-list"');
    expect(studio).toContain('tile={visibleImageInputs.length>1}');
    expect(imageCss).toMatch(/\.cf-image-input-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
    expect(css).toMatch(/\.ds-reftray__row\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
  });
  it("keeps angle and relight controls in the side panel",()=>{
    expect(studio).toContain('<PanelSection label="Angles">');
    expect(studio).toContain('<PanelSection label="Light">');
    expect(studio).toContain('<Flashlight compact');
    expect(studio).not.toContain('<Block label="Relight stage">');
    expect(studio).not.toContain('Nearby views · approximate');
    expect(studio).not.toContain('True angles · 3D geometry');
    expect(studio).toContain('controls.filter(control=>control.id==="prompt")');
    expect(studio).toContain('!anglesRoute&&!relight&&controls.some(control=>control.id!=="prompt"&&control.id!==imageSizeControl?.id)');
    expect(studio).not.toContain('>Relight subject</Button>');
  });

  it("keeps angle selection compact and batch output in the shared result area",()=>{
    expect(batch).toContain('<CameraAngleSheet compact');
    expect(batch).not.toContain('<ResultGrid');
    expect(batch).not.toContain('<ResultTile');
    expect(batch).not.toContain('<ResultSlot');
    expect(batch).toContain('selected={selected}');
    expect(batch).not.toContain('disabled={!!batch');
  });

  it("keeps result text actions legible over light images",()=>{
    expect(css).toMatch(/\.ds-resulttile__actions \.ds-btn\s*\{[^}]*background:\s*var\(--surface-control\)[^}]*color:\s*var\(--text-primary\)/s);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const editor = readFileSync("src/image/editor/ImageEditor.tsx", "utf8");
const components = readFileSync("src/ds/components.tsx", "utf8");
const styles = readFileSync("src/ds/components.css", "utf8");
const outline = readFileSync("src/image/editor/mask-outline.ts", "utf8");

describe("image editor shell", () => {
  it("opens an independent draggable color picker from either working-color swatch", () => {
    expect(editor).toContain('const [colorOpen, setColorOpen] = useState(false)');
    expect(editor).toContain('setColorOpen(true)');
    expect(editor).toContain('open={colorOpen}');
    expect(editor).toContain('anchor={colorRef} placement="right"');
    expect(editor).not.toContain('if (id === "color")');
    expect(components).toContain('placement?: "left" | "right"');
  });

  it("keeps AI Modify visible while its workflow is unavailable", () => {
    expect(editor).toContain('if (id === "ai") return (');
    expect(editor).toContain('AI Modify is not ready');
    expect(editor).toMatch(/!subjectRelight&&<Button variant="primary"/);
    expect(editor).not.toContain('if (id === "ai") return edit || precision');
  });

  it("keeps Modify focused while offering annotations and references", () => {
    expect(editor).toContain('title={subjectRelight?"Relight":"Modify"}');
    expect(editor).toContain('labelOutside label="What should change"');
    expect(editor).toContain('setReferencePicker(true)');
    expect(editor).toContain('>Add reference{');
    expect(editor).toContain('className="cf-modify-reference__count"');
    expect(editor).toContain('<FloatingPanel open={referenceTray} title="References"');
    expect(editor).toContain('<Toolbar className="cf-editor-ai-actions">');
    expect(editor).toContain('annotations.length?`Annotations · ${annotations.length}`:"Annotations"');
    expect(editor).toContain('onClick={() => void requestAi("modify")}>Modify</Button>');
    expect(editor).not.toContain('aria-controls="cf-editor-ai-advanced"');
    expect(editor).not.toContain('<InlineSelect label="Edit intent"');
    expect(editor).not.toContain('<InlineSelect label="Edit scope"');
    expect(editor).not.toContain('<Row label="Reference image"');
    expect(components).toContain('labelOutside?: boolean');
    expect(styles).toContain('.ds-prompt--label-outside textarea');
    expect(styles).toContain('.cf-editor-ai-actions { justify-content: flex-end; }');
  });

  it("keeps transform, painted quick masks, and direct erasing explicit", () => {
    expect(editor).toContain("Transforming layer:");
    expect(editor).toContain(">Transform layer</Button>");
    expect(styles).toMatch(/\.ds-transformrotate\s*\{[^}]*top:var\(--space-5\)/);
    expect(editor).toContain('Paint to select · Alt removes · Q exits');
    expect(editor).not.toContain('label="Quick mask target"');
    expect(editor).toContain('eraseMagicRegion({...doc,selection:combine');
    expect(editor).not.toContain('gutterSelection');
    expect(editor).toContain('selection:null,selectedId:null');
  });

  it("animates a fine marching-ants selection edge", () => {
    expect(editor).toContain('outlinePhase.current=(outlinePhase.current+1)%OUTLINE_PHASES');
    expect(outline).toContain('OUTLINE_FRAME_MS=140');
    expect(outline).toContain('OUTLINE_PHASES=8');
    expect(outline).toContain('ctx.lineDashOffset=-phase*pixel');
    expect(outline).toContain('ctx.lineWidth=2*pixel');
  });

  it("keeps character picking out of AI Modify and offers a genuinely soft radial brush", () => {
    expect(editor).not.toContain('display="Choose a saved character"');
    expect(editor).toContain('label: "Super soft round"');
    expect(editor).toContain('paintSuperSoftRound(ctx,x,y,size,color,brush.hardness)');
  });
});

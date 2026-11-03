import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Feature code may lay things out. Looks (color, font, border, radius, shadow, spacing in px) belong to src/ds.
const FEATURE_DIRS = ["src/team", "src/ui", "src/image"];
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const files = FEATURE_DIRS.filter((d) => existsSync(d)).flatMap(walk);
const css = files.filter((f) => f.endsWith(".css"));
const tsx = files.filter((f) => f.endsWith(".tsx"));

const FORBIDDEN = /^(color|background(-[a-z]+)?|font(-[a-z]+)?|border(-[a-z]+)?|border-radius|box-shadow|opacity|letter-spacing|line-height|text-(transform|decoration|shadow)|filter|backdrop-filter|outline(-[a-z]+)?)$/;
const SPACING = /^(padding|margin|gap|row-gap|column-gap)(-[a-z]+)?$/;

describe("design system guard", () => {
  it("feature CSS is layout only", () => {
    const problems: string[] = [];
    for (const f of css) {
      const text = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of text.matchAll(/([a-z-]+)\s*:\s*([^;}]+)/g)) {
        const [, prop, value] = m;
        if (FORBIDDEN.test(prop) && !(prop === "border" && /^0\b/.test(value.trim()))) problems.push(`${f}: ${prop}: ${value.trim()}`);
        if (SPACING.test(prop) && /\d+px/.test(value) && !/var\(/.test(value)) problems.push(`${f}: ${prop}: ${value.trim()} (use a token)`);
        if (/#[0-9a-f]{3,8}\b|rgba?\(/i.test(value)) problems.push(`${f}: ${prop}: ${value.trim()} (use a token)`);
        if (prop === "width" && value.trim() === "100%" && /\.ds-btn|button/.test(text.slice(Math.max(0, m.index! - 80), m.index))) problems.push(`${f}: full-width button`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("feature TSX uses DS components, not inline styles or raw structure", () => {
    const problems: string[] = [];
    for (const f of tsx) {
      const text = readFileSync(f, "utf8");
      if (/style=\{\{?/.test(text) && !f.includes("ModelPicker") && !f.includes("HistoryPage")) problems.push(`${f}: inline style`);
      if (/<details[\s>]/.test(text)) problems.push(`${f}: raw <details> (use Collapsible)`);
      for (const m of text.matchAll(/<h[1-3]([^>]*)>/g)) if (!/className="ds-/.test(m[1]) && !f.includes("LibrarySidebar")) problems.push(`${f}: raw heading (use SectionHeader)`);
    }
    expect(problems).toEqual([]);
  });

  it("every design-system component appears in the showcase (/#ds)", () => {
    const comps = readFileSync("src/ds/components.tsx", "utf8");
    const names = [...comps.matchAll(/export function ([A-Z][A-Za-z0-9]*)/g)].map((m) => m[1]);
    const showcase = readFileSync("src/ds/Showcase.tsx", "utf8");
    const missing = names.filter((n) => !new RegExp(`\\b${n}\\b`).test(showcase));
    expect(missing).toEqual([]);
  });

  it("keeps bookkeeping counters and run codes out of the default UI", () => {
    const media = ["src/ds/components.tsx", "src/ds/components.css", "src/image/ImageStudio.tsx", "src/image/AngleBatchPanel.tsx", "src/team/TeamLibrary.tsx", "src/team/TeamStoryboard.tsx"].map(f => readFileSync(f, "utf8")).join("\n");
    const rules = readFileSync("src/ds/README.md", "utf8");
    expect(media).not.toMatch(/ds-(?:resulttile|media)__slate|ds-slate|SC \$\{|TK \$\{/);
    expect(rules).toContain("Keep forms and media free of bookkeeping");
  });

  it("feature code reuses DS components for common functions", () => {
    const problems: string[] = [];
    for (const f of tsx) {
      const text = readFileSync(f, "utf8");
      if (/<input[^>]*type="file"/.test(text)) problems.push(`${f}: native file input (use UploadSlot)`);
      if (/<a className="ds-btn/.test(text)) problems.push(`${f}: anchor styled as button (use LinkButton)`);
      if (/ds-project-field/.test(text)) problems.push(`${f}: hand-made field (use TextField)`);
      if (/<input[^>]*type="(text|email|password|url|number|search)"/.test(text)) problems.push(`${f}: raw input (use TextField or SearchField)`);
      if (/<input[^>]*type="checkbox"/.test(text)) problems.push(`${f}: raw checkbox (use Checkbox)`);
      if (/<SectionHeader[^>]*\bend=\{<(Toolbar|Button|GlassButton)/.test(text)) problems.push(`${f}: controls inside a SectionHeader (use PanelSection, PickerRow or AddButton)`);
      if (/<SectionHeader[^>]*\bend=\{[a-zA-Z]*[Bb]utton/.test(text)) problems.push(`${f}: button inside a SectionHeader (use AddButton at the end of the list)`);
      if (/(Planned · not implemented|Not available yet|Coming soon|Coming later|Unavailable · No approved|Next: )/i.test(text) && !f.includes("CapabilityCatalogue")) problems.push(`${f}: placeholder copy for something that does not exist (rule 26: leave it out)`);
      // A self-closing Notice has no body, so it cannot hold buttons; drop those before the check.
      const notices = text.replace(/actions=\{<>[\s\S]*?<\/>\}/g, "").replace(/<Notice[^<]*?\/>/g, "");
      if (/<div[^>]*role="alert"[^>]*>\s*<Notice/.test(text)) problems.push(`${f}: second alert region around a Notice (rule 36: the problem bar is the only place)`);
      if (/<Notice(?:[^>]|=>)*>(?:(?!<\/Notice>)[\s\S])*?<(Button|LinkButton)[\s>]/.test(notices)) problems.push(`${f}: buttons mixed into a Notice (use its actions prop)`);
      if (/<Notice[^>]*title=["{`]+No [a-z]/.test(text)) problems.push(`${f}: empty state shown as a Notice (use EmptyState)`);
      if (/<Meta[^>]*>\s*(Local ComfyUI|Shared on your team server)\s*<\/Meta>/.test(text) || /Latest 200 runs/.test(text) || /parts=\{\["Shared"[,\]]/.test(text)) problems.push(`${f}: constant caption (rule 31: say it once, or not at all)`);
      if (/<textarea/.test(text)) problems.push(`${f}: raw textarea (use PromptField)`);
      if (/<article[ >]/.test(text) && /className="cf-/.test(text.slice(text.indexOf("<article")))) problems.push(`${f}: custom card (use MediaCard, Result or HistoryItem)`);
    }
    expect(problems).toEqual([]);
  });

  it("does not show tabs or entries that cannot work (rule 26)", () => {
    const problems: string[] = [];
    for (const f of tsx) {
      readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => {
        if (/label:\s*["`]/.test(line) && /disabled:\s*(true|!)/.test(line)) problems.push(`${f}:${i + 1}: disabled tab or entry (leave it out)`);
      });
    }
    expect(problems).toEqual([]);
  });

  it("keeps the desktop studio floor and has no phone-only design branches (rule 27)",()=>{
    const designCss=["src/ds/tokens.css","src/ds/components.css","src/team/team.css"].map(f=>readFileSync(f,"utf8")).join("\n");
    const base=readFileSync("src/ds/base.css","utf8");
    expect(designCss).not.toMatch(/@media\s*\(\s*(?:max-width|hover\s*:\s*none)/);
    expect(base).toMatch(/html, body, #root\s*\{[^}]*min-width:\s*1280px/);
  });

  it("every design-system class used by a component has a style rule", () => {
    const comps = readFileSync("src/ds/components.tsx", "utf8");
    const styles = readFileSync("src/ds/components.css", "utf8") + readFileSync("src/ds/base.css", "utf8");
    const used = new Set<string>();
    for (const m of comps.matchAll(/["'`]((?:ds-[a-z0-9_-]+)(?: ds-[a-z0-9_-]+)*)["'`]/g)) for (const cls of m[1].split(" ")) if (!cls.endsWith("-") && !cls.endsWith("--")) used.add(cls);
    const missing = [...used].filter((cls) => !styles.includes(`.${cls}`));
    expect(missing).toEqual([]);
  });

  it("uses one context bar and no extra navigation bar in the team app", () => {
    const uses = files.filter((f) => f.endsWith(".tsx")).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/<ContextBar[\s>]/g)].map(() => f));
    expect(uses.length).toBeLessThanOrEqual(1);
  });
});

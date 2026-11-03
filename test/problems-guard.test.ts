import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Rule 36: every problem carries its fix, and a screen has one problem region.
 *
 * This is a static check over the source, not a comment: it reads each feature module, finds every
 * problem `Notice` and every not-ready `EmptyState`, and fails on one that states a problem without
 * the action that clears it, or on a module that builds its own alert area beside the problem bar.
 *
 * Things that legitimately carry no action of their own, and why:
 * - `inline` keeps a form's own problem next to its field, where that form's action already is.
 * - `consequence` marks a problem that is only a result of another one, so it stays hidden while the
 *   cause (which carries the action) is shown. `selectProblems` in src/ds does the hiding.
 * - `tone="info"` is a hint, not a failure: a requirement, a frozen request, a hardware tier.
 * - An `EmptyState` for a read-only or signed-out context has no action to take (rule 26).
 */

const FEATURE_DIRS = ["src/team", "src/ui", "src/image"];
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
const files = FEATURE_DIRS.filter((dir) => existsSync(dir)).flatMap(walk).filter((file) => file.endsWith(".tsx"));

type Region = {
  file: string;
  line: number;
  kind: "Notice" | "EmptyState";
  props: string;
  info: boolean;
  inline: boolean;
  consequence: boolean;
  hasAction: boolean;
  title: string;
};

/** The end index of a JSX opening tag that starts at `start`, honouring braces and quotes. */
function tagEnd(text: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{" || char === "(" || char === "[") depth++;
    else if (char === "}" || char === ")" || char === "]") depth--;
    else if (char === ">" && depth === 0) return index;
  }
  return -1;
}

function regions(file: string): Region[] {
  const text = readFileSync(file, "utf8");
  const found: Region[] = [];
  for (const kind of ["Notice", "EmptyState"] as const) {
    const pattern = new RegExp(`<${kind}[\\s/>]`, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const end = tagEnd(text, match.index);
      if (end < 0) continue;
      const props = text.slice(match.index + 1 + kind.length, end);
      const titleProp = /title\s*=\s*("([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/.exec(props);
      found.push({
        file,
        line: text.slice(0, match.index).split("\n").length,
        kind,
        props,
        info: /tone\s*=\s*["']info["']/.test(props) || /tone\s*=\s*\{\s*["']info["']/.test(props),
        inline: /\binline\b(?!\s*=)/.test(props),
        consequence: /\bconsequence\b(?!\s*=)/.test(props),
        hasAction: (kind === "Notice" ? /\bactions\s*=/ : /\baction\s*=/).test(props),
        title: titleProp ? (titleProp[2] ?? titleProp[3] ?? titleProp[4] ?? "") : "",
      });
    }
  }
  return found;
}

const all = files.flatMap(regions);
const where = (region: Region) => `${region.file}:${region.line}`;
const headline = (region: Region) => region.title || region.props.replace(/\s+/g, " ").slice(0, 70);

/** A title that promises something is wrong, missing, offline or not ready. */
const PROBLEM_TITLE = /\b(offline|unavailable|failed|failure|didn't|couldn't|could not|can't|cannot|not ready|isn't ready|missing|needs|error|unreachable|required|denied|no longer|stopped|blocked|not set up|not loaded|did not)\b/i;

describe("every problem carries its fix (rule 36)", () => {
  it("reads the feature source", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(all.length).toBeGreaterThan(100);
  });

  it("never states a problem without the action that clears it", () => {
    const problems = all
      .filter((region) => region.kind === "Notice" && !region.info && !region.inline && !region.consequence && !region.hasAction)
      .map((region) => `${where(region)}: problem Notice with no actions prop — ${headline(region)}`);
    expect(problems).toEqual([]);
  });

  it("never states a not-ready state without its next step", () => {
    const problems = all
      .filter((region) => region.kind === "EmptyState" && !region.hasAction && PROBLEM_TITLE.test(`${region.title} ${region.props}`))
      .map((region) => `${where(region)}: not-ready EmptyState with no action — ${headline(region)}`);
    expect(problems).toEqual([]);
  });

  it("keeps every problem in the one problem region (rule 36)", () => {
    /* A screen owns no alert area of its own: Notices flow into the DS problem bar, and anything
       that looks like a second error region is a screen rebuilding the design system (rule 54). */
    const problems: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      text.split(/\r?\n/).forEach((line, index) => {
        if (/role\s*=\s*["']alert["']/.test(line) && !/ds-problem/.test(line)) problems.push(`${file}:${index + 1}: own alert region (use Notice, which flows into the problem bar)`);
        if (/aria-live\s*=\s*["']assertive["']/.test(line)) problems.push(`${file}:${index + 1}: assertive live region (use Notice)`);
        if (/ds-problem(row|bar)/.test(line)) problems.push(`${file}:${index + 1}: hand-made problem row (the DS renders it)`);
      });
    }
    expect(problems).toEqual([]);
  });

  it("says one cause once, not as a Notice and an EmptyState together", () => {
    const problems: string[] = [];
    for (const file of files) {
      const inFile = all.filter((region) => region.file === file && region.title);
      for (const notice of inFile.filter((region) => region.kind === "Notice")) {
        const twin = inFile.find((region) => region.kind === "EmptyState" && region.title === notice.title);
        if (twin) problems.push(`${where(notice)} and ${where(twin)}: "${notice.title}" is both a Notice and an EmptyState`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("never sends the person outside the app to fix a problem", () => {
    const problems: string[] = [];
    for (const region of all) {
      if (!/reload this page|refresh this page|restart the server|then reload|reload the page/i.test(region.props)) continue;
      problems.push(`${where(region)}: problem text asks for a manual reload — its action performs the recheck`);
    }
    expect(problems).toEqual([]);
  });
});

/* What a screenshot run means, decided without a browser.
   scripts/screenshot-routes.mjs captures the screens and measures the pixels; this module
   says what changed and what counts as a failure. No browser, no filesystem and no clock,
   so test/screenshot-diff-lib.test.ts can hand it fake manifests. */

/**
 * One captured screen: one route at one viewport width.
 * @typedef {{route:string,width:number,height:number,file?:string,sha256?:string,ready?:boolean,bodyChars?:number}} Shot
 * @typedef {{version?:number,entries?:Shot[]}} Manifest
 * @typedef {{route:string,width?:number}} AllowEntry
 */

/** Rows that fail a run unless the task lists them as an intended diff. */
const FAILING = new Set(["changed", "size-changed", "new", "missing", "not-ready"]);

/** @param {Shot} shot */
export function shotKey(shot) { return `${shot.route}@${shot.width}`; }

/**
 * An allow list may be written four ways: a bare route name, a `{route}` object, a
 * `{route,width}` object, or a whole JSON file payload `{allow:[...]}`. Anything else is
 * dropped and reported, so a broken allow file can never silently allow a screen.
 * @param {unknown} input
 * @returns {{entries:AllowEntry[],problems:string[]}}
 */
export function normaliseAllow(input) {
  const problems = [];
  let raw;
  if (Array.isArray(input)) raw = input;
  else if (input && typeof input === "object" && Array.isArray(input.allow)) raw = input.allow;
  else if (input === undefined || input === null) raw = [];
  else { problems.push("allow list is not an array or {allow:[...]} object"); raw = []; }
  const entries = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) { entries.push({ route: item.trim() }); continue; }
    if (item && typeof item === "object" && typeof item.route === "string" && item.route.trim()) {
      if (item.width === undefined) entries.push({ route: item.route.trim() });
      else if (Number.isFinite(Number(item.width))) entries.push({ route: item.route.trim(), width: Number(item.width) });
      else problems.push(`width is not a number for ${item.route}`);
      continue;
    }
    problems.push(`dropped an allow entry: ${JSON.stringify(item)}`);
  }
  return { entries, problems };
}

/**
 * @param {AllowEntry[]} allow
 * @param {string} route
 * @param {number} width
 */
function isAllowed(allow, route, width) {
  return allow.some((a) => a.route === route && (a.width === undefined || a.width === width));
}

/**
 * Compare a baseline manifest with a fresh run.
 * @param {Manifest} baseline
 * @param {Manifest} current
 * @param {unknown} [allowInput]
 */
export function compareManifests(baseline, current, allowInput) {
  const { entries: allow, problems: warnings } = normaliseAllow(allowInput);
  const before = new Map((baseline?.entries ?? []).map((entry) => [shotKey(entry), entry]));
  const after = new Map((current?.entries ?? []).map((entry) => [shotKey(entry), entry]));
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => {
    const [routeA, widthA] = a.split("@"), [routeB, widthB] = b.split("@");
    return routeA === routeB ? Number(widthA) - Number(widthB) : routeA < routeB ? -1 : 1;
  });

  const rows = keys.map((key) => {
    const was = before.get(key);
    const is = after.get(key);
    const source = was ?? is;
    const route = source.route, width = source.width;
    const allowed = isAllowed(allow, route, width);
    const row = { key, route, width, height: (is ?? was).height, allowed, changedPixels: null, note: "" };
    if (!was) return { ...row, status: "new", note: "no baseline entry: run --baseline" };
    if (!is) return { ...row, status: "missing", note: "the run did not capture this screen" };
    if (!is.ready) return { ...row, status: "not-ready", changedPixels: null, note: `the screen did not render (${is.bodyChars ?? 0} characters of text)` };
    if (was.width !== is.width || was.height !== is.height) {
      return { ...row, status: "size-changed", note: `${was.width}x${was.height} -> ${is.width}x${is.height}` };
    }
    if (was.sha256 && is.sha256 && was.sha256 === is.sha256) return { ...row, status: "same", changedPixels: 0 };
    return { ...row, status: allowed ? "changed-allowed" : "changed" };
  });

  // An allow list excuses a look change, and nothing else: a screen that vanished, appeared
  // without a baseline, or did not render is a broken run, not an intended diff.
  for (const row of rows) {
    if (!row.allowed || (row.status !== "new" && row.status !== "missing" && row.status !== "not-ready")) continue;
    row.allowed = false;
    row.note = `${row.note ? `${row.note}; ` : ""}an allow entry cannot excuse this`;
  }

  // An allow entry that matches no row is a typo, and a typo would hide a real change.
  for (const entry of allow) {
    if (!rows.some((row) => row.route === entry.route && (entry.width === undefined || entry.width === row.width))) {
      warnings.push(`allow entry matches no screen: ${entry.route}${entry.width === undefined ? "" : `@${entry.width}`}`);
    }
  }

  return { rows, failures: rows.filter((row) => FAILING.has(row.status) && !row.allowed), warnings };
}

/**
 * The run as a plain table: route, width, status, changed pixels.
 * @param {Array<{route:string,width:number,status:string,changedPixels:number|null,note?:string}>} rows
 */
export function formatTable(rows) {
  const header = ["route", "width", "status", "pixels", "note"];
  const body = rows.map((row) => [
    row.route,
    String(row.width),
    row.status,
    row.changedPixels === null || row.changedPixels === undefined ? "-" : String(row.changedPixels),
    row.note ?? "",
  ]);
  const widths = header.map((cell, index) => Math.max(cell.length, ...body.map((line) => line[index].length)));
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
  return [line(header), ...body.map(line)].join("\n");
}

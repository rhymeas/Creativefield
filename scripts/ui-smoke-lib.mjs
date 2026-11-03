// Classification of one screen's raw smoke events into findings. Pure: no browser, no
// filesystem, no clock. scripts/ui-smoke.mjs collects the raw events, this decides what
// counts as a break, and test/ui-smoke-lib.test.ts checks it with fake events.

/** Words that make a Notice a problem rather than a hint (design README rule 30: a Notice is for a problem). */
const PROBLEM_PHRASES = ["something went wrong", "not allowed", "failed"];

/** Actions the smoke check never clicks: they would write to the server or start work. */
const FORBIDDEN_ACTIONS = ["generate", "queue", "upload", "delete", "remove", "save", "create", "apply", "confirm", "cancel run", "resolve", "mark"];

function clean(text, max = 240) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** True when a Notice's text says something broke. A plain hint ("Drafts remain available") is not a finding. */
export function noticeLooksBroken(text) {
  const value = String(text ?? "").toLowerCase();
  return PROBLEM_PHRASES.some((phrase) => value.includes(phrase));
}

/** True when clicking a control with this label would write, delete or start a run. */
export function isForbiddenAction(label) {
  const value = clean(label).toLowerCase().replace(/[.…]+$/, "");
  return FORBIDDEN_ACTIONS.some((action) => value === action || value.startsWith(`${action} `));
}

/**
 * One screen's raw events in, findings out. Every finding keeps the step (the click) that
 * caused it, so the report says what broke, not only where.
 * @param {import("./ui-smoke-lib.mjs").RawScreen} raw
 * @returns {import("./ui-smoke-lib.mjs").SmokeFinding[]}
 */
export function classifyScreen(raw) {
  const screen = clean(raw?.screen) || "unknown";
  const findings = [];
  const seen = new Set();
  const add = (step, kind, message) => {
    const at = clean(step) || "open";
    const text = clean(message);
    if (!text) return;
    const key = `${at}|${kind}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ screen, step: at, kind, message: text });
  };
  for (const event of raw?.consoleErrors ?? []) add(event.step, "console-error", event.text);
  for (const event of raw?.pageErrors ?? []) add(event.step, "page-error", event.text);
  for (const event of raw?.responses ?? []) add(event.step, "http-error", `${event.status} ${event.url}`);
  for (const event of raw?.notices ?? []) {
    if (noticeLooksBroken(event.text)) add(event.step, "notice", event.text);
  }
  for (const event of raw?.overflows ?? []) {
    add(event.step, "overflow", `${event.selector} is ${event.scroll}px wide inside ${event.client}px`);
  }
  for (const event of raw?.blocked ?? []) {
    add(event.step, "blocked-request", `${event.method} ${event.url} was blocked (read-only)`);
  }
  for (const check of raw?.checks ?? []) {
    if (check?.ok !== false) continue;
    add(check.step, "check-failed", check.message || check.name);
  }
  if (raw?.emptyBody) add(raw.emptyBody.step, "empty-body", `the body stayed empty for ${raw.emptyBody.waitedSeconds ?? 5} s`);
  return findings;
}

import type { Readiness, Requirement } from "../capabilities/types";
import type { Worker } from "./api";

/**
 * One place that turns a technical failure into everyday words, the one action that clears it,
 * and the raw text kept for support behind "Details" (rule 36, rule 39).
 *
 * Nothing here prints a code in the sentence a person reads: `object_info:request_failed` is a
 * fact for support, so it travels in `details` and the screen shows it only when asked.
 */

/** The one action that clears a problem. A screen turns it into a button carrying this label. */
export type FixKind = "start-comfy" | "connect-comfy" | "check-again" | "open-settings" | "open-models" | "run-local" | "retry";
export type ProblemFix = { kind: FixKind; label: string };
export type PlainProblem = {
  title: string;
  /** What happened, in everyday words. Never a code, a colon-joined identifier or a stack fragment. */
  text: string;
  fix: ProblemFix;
  /** The technical text, for support. Shown only behind "Details". */
  details?: string;
};
/** The place that changes what the person needs, named in this mode's words ("Settings" or "Team settings"). */
export type ProblemContext = { address?: string; settings?: string };

const FIX_LABELS: Record<FixKind, string> = {
  "start-comfy": "Start ComfyUI",
  "connect-comfy": "Connect ComfyUI",
  "check-again": "Check again",
  "open-settings": "Open worker settings",
  "open-models": "Open Models",
  "run-local": "Run on this computer",
  retry: "Try again",
};
export const fixFor = (kind: FixKind): ProblemFix => ({ kind, label: FIX_LABELS[kind] });

/** A code, a file position, a stack frame or a runtime error name: never something to show in a sentence. */
export function looksTechnical(text: string): boolean {
  return /(?:^|[\s(])[a-z_]+\/[a-z_]+:[a-z_]+/i.test(text)
    || /(?:^|[\s(])[a-z_]+:[a-z_]+(?=$|[\s,.;)])/.test(text)
    || /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|ENOSPC|EACCES|EPIPE|EAI_AGAIN)\b/.test(text)
    || /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|ApiError)\b/.test(text)
    || /Request failed \(\d{3}\)/.test(text)
    || /(?:^|\s)at\s+\S+\s+\([^)]*:\d+:\d+\)/.test(text)
    || /(?:^|\s)at\s+\S+:\d+:\d+/.test(text)
    || /\bstack\b/i.test(text);
}

type LibraryCode = "request_failed" | "invalid_response";
type LibraryIssue = { scope: string; code: LibraryCode; folder?: string };

/** `object_info:request_failed`, `models:request_failed`, `models/loras:invalid_response`. */
function parseIssue(issue: string): LibraryIssue | null {
  const at = issue.lastIndexOf(":");
  if (at <= 0) return null;
  const scope = issue.slice(0, at).trim(), code = issue.slice(at + 1).trim();
  if (code !== "request_failed" && code !== "invalid_response") return null;
  return { scope, code, folder: scope.startsWith("models/") ? scope.slice("models/".length) : undefined };
}

const at = (context: ProblemContext) => context.address ? ` at ${context.address}` : "";

function notAnswering(context: ProblemContext, details: string): PlainProblem {
  return { title: "ComfyUI isn't answering", text: `ComfyUI isn't answering${at(context)}. It may not be running.`, fix: fixFor("start-comfy"), details };
}
function wrongServer(context: ProblemContext, details: string): PlainProblem {
  return { title: "Something else is answering", text: `Something else is answering${at(context)}, not ComfyUI. Check the address in ${context.settings ?? "Settings"}.`, fix: fixFor("open-settings"), details };
}

/**
 * The problem behind a failed read of ComfyUI's models and node list. Several failed folders that
 * have one cause become one message (rule 36), because they are one problem the person has.
 */
export function libraryProblem(issues: string[], context: ProblemContext = {}): PlainProblem | null {
  const parsed = issues.map(parseIssue).filter((issue): issue is LibraryIssue => !!issue);
  const details = issues.join("\n");
  if (!parsed.length) return issues.length ? plainProblem(issues.join(" "), context) : null;
  if (parsed.some(issue => !issue.folder && issue.code === "request_failed")) return notAnswering(context, details);
  if (parsed.some(issue => !issue.folder && issue.code === "invalid_response")) return wrongServer(context, details);
  const folders = [...new Set(parsed.map(issue => issue.folder).filter((folder): folder is string => !!folder))];
  if (!folders.length) return parsed[0].code === "invalid_response" ? wrongServer(context, details) : notAnswering(context, details);
  const named = folders.length === 1 ? `the ${folders[0]} folder` : `${folders.length} folders (${folders.slice(0, 3).join(", ")})`;
  return { title: "Some model folders couldn't be read", text: `ComfyUI couldn't list ${named}. Every other model is still there.`, fix: fixFor("check-again"), details };
}

/** One folder the library could not list, said without its code. */
export function folderProblem(folder: string, code: LibraryCode): string {
  return code === "invalid_response" ? `The ${folder} folder answered with something that isn't a file list.` : `The ${folder} folder didn't answer.`;
}

/** A message that is already a sentence a person wrote for a person: it is shown as it is. */
export function plainAlready(text: string): boolean {
  return text.length > 12 && /^[A-Z]/.test(text) && /[.!]$/.test(text) && !looksTechnical(text);
}

/**
 * Any failed request or worker message, in everyday words. Every answer carries one action; an
 * unknown message keeps its own text for support and offers "Try again".
 */
export function plainProblem(raw: string, context: ProblemContext = {}): PlainProblem {
  const text = (raw ?? "").trim();
  const details = text || "No detail was reported.";
  /* Words written for a person ("Choose a project with creator access to save a crop.") are not
     rewritten: the map exists for codes and runtime messages, not for our own sentences. */
  if (plainAlready(text)) return { title: "", text, fix: fixFor("retry") };
  const issue = parseIssue(text);
  if (issue) return libraryProblem([text], context) ?? notAnswering(context, details);
  if (/ECONNREFUSED|refused the connection/i.test(text)) return notAnswering(context, details);
  if (/ENOTFOUND|EAI_AGAIN|host name did not resolve|name or service not known/i.test(text)) {
    return { title: "That address doesn't exist", text: `Nothing answers${at(context)}. Check the address in ${context.settings ?? "Settings"}.`, fix: fixFor("open-settings"), details };
  }
  if (/ETIMEDOUT|timed out|timeout|did not answer in time|took too long/i.test(text)) {
    return { title: "That took too long", text: "The request didn't finish in time. Try again in a moment.", fix: fixFor("retry"), details };
  }
  if (/ECONNRESET|socket hang up|connection (?:was )?(?:closed|reset)/i.test(text)) {
    return { title: "The connection dropped", text: "ComfyUI closed the connection before it answered. Try again.", fix: fixFor("check-again"), details };
  }
  if (/ENOSPC|no space left|disk (?:is )?full/i.test(text)) {
    return { title: "This computer is out of disk space", text: "Free some space on the drive that holds the models, then try again. Models shows how much room each drive has.", fix: fixFor("open-models"), details };
  }
  if (/Workspace permission required|permission required|forbidden|^403\b/i.test(text)) {
    return { title: "This workspace doesn't allow that", text: "You can look, but not change this workspace. Try again after your access is updated.", fix: fixFor("retry"), details };
  }
  if (/(?:not found|^404\b)/i.test(text)) {
    return { title: "That is no longer here", text: "It was removed, or belongs to another project. Reload this screen to see what is left.", fix: fixFor("retry"), details };
  }
  if (/invalid request|^400\b|validation/i.test(text)) {
    return { title: "The server refused this request", text: "Something in this request is not accepted. Check the fields on screen, then try again.", fix: fixFor("retry"), details };
  }
  if (/Team server unavailable|server unavailable|failed to fetch|fetch failed|networkerror|load failed/i.test(text)) {
    return { title: "The server isn't reachable", text: "CreativeField couldn't reach its own server. Nothing was sent twice. Try again.", fix: fixFor("retry"), details };
  }
  const status = /Request failed \((\d{3})\)/.exec(text)?.[1];
  if (status) return Number(status) >= 500
    ? { title: "The server had a problem", text: "It could not finish this request. Try again; if it keeps failing, the details help support.", fix: fixFor("retry"), details }
    : { title: "The server refused this request", text: "Something in this request is not accepted. Try again, or change what you asked for.", fix: fixFor("retry"), details };
  return { title: "Something went wrong", text: "This didn't work, and the reason is not one CreativeField recognises. Try again; the details help support.", fix: fixFor("retry"), details };
}

/** Readiness reasons are already sentences; a code that slips in is said in words instead. */
export function plainReasons(reasons: string[], context: ProblemContext = {}): string {
  return reasons.map(reason => looksTechnical(reason) ? plainProblem(reason, context).text : reason).join(" ");
}

function needsText(missing: Requirement[]): string {
  const models = missing.filter(item => item.kind === "model").length;
  const nodes = missing.filter(item => item.kind === "node").length;
  const rest = missing.length - models - nodes;
  return [
    models ? `${models} ${models === 1 ? "model" : "models"}` : "",
    nodes ? `${nodes} ${nodes === 1 ? "node" : "nodes"}` : "",
    rest ? `${rest} other ${rest === 1 ? "file" : "files"}` : "",
  ].filter(Boolean).join(nodes || rest ? " and " : ", ");
}

/** Why this tool cannot run on the chosen worker, and the one action that gets it running. */
export type BlockerCause = "starting" | "offline" | "no-worker" | "missing-files" | "credentials" | "incompatible";
export type WorkerBlocker = PlainProblem & { cause: BlockerCause };

export function workerBlocker(input: {
  worker?: Worker;
  workers: Worker[];
  readiness: Readiness | null;
  /** A registered worker that is not answering, so its Start action can be offered. */
  offlineWorker?: Worker;
  starting: boolean;
  settings?: string;
  /** Picking this computer is a real way out of a cloud run that cannot start. */
  canRunLocal?: boolean;
}): WorkerBlocker | null {
  const { worker, workers, readiness, offlineWorker, starting, settings = "Settings", canRunLocal } = input;
  if (starting) return { cause: "starting", title: "ComfyUI is starting", text: "This model runs as soon as ComfyUI answers.", fix: fixFor("start-comfy") };
  if (offlineWorker) return offlineBlocker(offlineWorker);
  if (!workers.length) {
    return { cause: "no-worker", title: "Not connected to ComfyUI", text: `CreativeField isn't connected to ComfyUI yet. Add its address in ${settings} and check it.`, fix: fixFor("connect-comfy") };
  }
  const state = readiness?.state;
  if (!readiness || state === "ready") return null;
  if (state === "offline") return offlineBlocker(worker ?? workers[0]);
  const missing = readiness.missing ?? [];
  if ((state === "install_required" || state === "download_required") && missing.length) {
    return { cause: "missing-files", title: "This tool needs more files", text: `This tool needs ${needsText(missing)} before it can run here. Models shows which ones and where they go.`, fix: fixFor("open-models"), details: missing.map(item => `${item.kind} ${item.name}${item.location ? ` (${item.location})` : ""}`).join("\n") };
  }
  if (state === "credentials_required") {
    return { cause: "credentials", title: "This run can't start here", text: plainReasons(readiness.reasons, { settings }) || "This account cannot start runs from CreativeField.", fix: fixFor(canRunLocal ? "run-local" : "open-settings"), details: readiness.reasons.join("\n") };
  }
  if (state === "incompatible") {
    const detail = missing.length ? missing.map(item => `${item.kind} ${item.name}`).join("\n") : readiness.reasons.join("\n");
    return { cause: "incompatible", title: "This worker can't run this tool", text: plainReasons(readiness.reasons, { settings }) || `The worker is missing something this tool needs. Check it in ${settings}.`, fix: fixFor("open-settings"), details: detail };
  }
  /* A route that was never implemented is not a worker problem: there is nothing here to fix. */
  return null;
}

function offlineBlocker(worker: Worker): WorkerBlocker {
  return { cause: "offline", title: "ComfyUI is offline", text: worker.can_start ? "Start it on this computer to run this model." : "ComfyUI isn't running. Start it on the computer that runs it, then check again.", fix: fixFor(worker.can_start ? "start-comfy" : "check-again") };
}

/** A cookie for this file: the raw shape ui-smoke.mjs collects for one screen. */
export type SmokeFindingKind = "console-error" | "page-error" | "http-error" | "notice" | "overflow" | "blocked-request" | "check-failed" | "empty-body";

/** One event, tagged with the step (the click) that was running when it arrived. */
export interface StepEvent {
  step: string;
}

export interface ConsoleErrorEvent extends StepEvent {
  text: string;
}
export interface PageErrorEvent extends StepEvent {
  text: string;
}
export interface ResponseEvent extends StepEvent {
  url: string;
  status: number;
}
export interface NoticeEvent extends StepEvent {
  /** The visible text of the Notice. */
  text: string;
}
export interface OverflowEvent extends StepEvent {
  /** A readable selector for the element that is wider than its parent. */
  selector: string;
  /** The element's own scroll width. */
  scroll: number;
  /** The width it is allowed to use. */
  client: number;
}
export interface BlockedRequestEvent extends StepEvent {
  method: string;
  url: string;
}
export interface CheckEvent extends StepEvent {
  /** What was checked, for example "actions: Edit". */
  name: string;
  ok: boolean;
  /** What to report when the check fails. */
  message: string;
}

/** Everything collected while one screen was open. */
export interface RawScreen {
  screen: string;
  consoleErrors?: ConsoleErrorEvent[];
  pageErrors?: PageErrorEvent[];
  responses?: ResponseEvent[];
  notices?: NoticeEvent[];
  overflows?: OverflowEvent[];
  blocked?: BlockedRequestEvent[];
  checks?: CheckEvent[];
  /** Set when the body stayed empty; the step says which click led there. */
  emptyBody?: { step: string; waitedSeconds?: number } | null;
}

export interface SmokeFinding {
  screen: string;
  step: string;
  kind: SmokeFindingKind;
  message: string;
}

/** True when a Notice's text says something broke. */
export function noticeLooksBroken(text: string): boolean;
/** True when clicking a control with this label would write, delete or start a run. */
export function isForbiddenAction(label: string): boolean;
/** One screen's raw events in, findings out. Pure: no browser, no filesystem, no clock. */
export function classifyScreen(raw: RawScreen): SmokeFinding[];

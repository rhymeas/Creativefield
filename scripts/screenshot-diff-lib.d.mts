/** Typed face of screenshot-diff-lib.mjs, so the tests and the capture script are checked. */

/** One captured screen: one route at one viewport width. */
export interface Shot {
  route: string;
  width: number;
  height: number;
  file?: string;
  hash?: string;
  sha256?: string;
  /** False when the screen never showed real text, so nothing can be compared. */
  ready?: boolean;
  bodyChars?: number | null;
}

export interface Manifest {
  version?: number;
  capturedAt?: string;
  base?: string;
  chromium?: string;
  entries?: Shot[];
}

/** One route, as a plain name or narrowed to one viewport width. */
export interface AllowEntry {
  route: string;
  width?: number;
}

export type RowStatus = "same" | "changed" | "changed-allowed" | "size-changed" | "new" | "missing" | "not-ready";

export interface Row {
  key: string;
  route: string;
  width: number;
  height: number;
  status: RowStatus;
  /** Measured later by the capture script; null until then. */
  changedPixels: number | null;
  allowed: boolean;
  note: string;
}

export interface Comparison {
  rows: Row[];
  failures: Row[];
  warnings: string[];
}

export function shotKey(shot: Pick<Shot, "route" | "width">): string;
/** Accepts a route list, `{route}`, `{route,width}` objects, or a whole `{allow:[...]}` file. */
export function normaliseAllow(input: unknown): { entries: AllowEntry[]; problems: string[] };
/** Compare a baseline manifest with a fresh run: what changed, and what fails the run. */
export function compareManifests(baseline: Manifest, current: Manifest, allowInput?: unknown): Comparison;
/** The run as a plain table: route, width, status, changed pixels. */
export function formatTable(rows: Row[]): string;

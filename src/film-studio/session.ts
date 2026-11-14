/*
 * Shared state of the Film Studio workspace. The shell owns the score, the
 * playhead and the reference media; modules read them and call the actions.
 * Keeping this in one type is what makes a module (Blocking, Shots, and later
 * Analysis or Generation) a drop-in: it never owns the timeline itself.
 */
import type {StageFrame, StageScore, YamlDiagnostic} from "./score/schema";
import type {LabelMode, ViewMode} from "./stage/StageViewport";
import {shotStatusLabel, type ShotStatus} from "./shot-status";
import type {AnalysisCacheState, ShotGeometry, ShotSkip} from "./analysis-contract";
import type {Project, Workspace} from "../team/api";
import type {VideoHandoff} from "../capabilities/shot-direction";

export type FilmStudioModuleId = "blocking" | "shots" | "geometry";

/** What the timeline is synchronised against. */
export type ReferenceSource =
  | {kind: "none"}
  | {kind: "procedural"}
  | {kind: "youtube"; url: string; videoId: string; section?: YoutubeSection}
  | {kind: "file"; name: string; url: string; blob?: Blob};

export type FilmStudioSession = {
  /** The workspace and project this studio is editing, for modules that reach app features. */
  workspace?: Workspace;
  project?: Project;
  canCreate: boolean;
  score: StageScore;
  /** False until a score parses; a module can rely on it. */
  frame: StageFrame;
  scoreText: string;
  time: number;
  playing: boolean;
  /** Repeat the whole score when the playhead reaches the end. */
  loop: boolean;
  /** Reference audio on or off. */
  sound: boolean;
  reference: ReferenceSource;
  view: ViewMode;
  labels: LabelMode;
  module: FilmStudioModuleId;
  error: string;
  warnings: YamlDiagnostic[];
  canSendToVideo: boolean;
  seek: (time: number) => void;
  setPlaying: (playing: boolean) => void;
  setLoop: (loop: boolean) => void;
  setSound: (sound: boolean) => void;
  setModule: (id: FilmStudioModuleId) => void;
  setView: (view: ViewMode) => void;
  setLabels: (labels: LabelMode) => void;
  setReference: (reference: ReferenceSource) => void;
  /** Dragging the viewport in a locked view pauses the score and hands over to Free orbit. */
  unlockView: () => void;
  openEditor: () => void;
  exportScore: () => void;
  /** Replace the whole score with generated YAML (reference analysis); returns an error message or "". */
  applyGeneratedScore: (yaml: string) => string;
  /** Hand the finished grey-block clip to the AI video generation flow. */
  /** Hand a rendered grey-block clip to Make it real, with the shot direction written from the score. */
  sendToVideo?: (assetId: string, handoff?: VideoHandoff) => void;
  /** Per-shot analysis state, index = shot index (transitions in shot-status.ts). */
  shotStatuses: ShotStatus[];
  setShotStatuses: (statuses: ShotStatus[]) => void;
  /** The one progressive-analysis line: what is running now. */
  analysisStage: string;
  setAnalysisStage: (stage: string) => void;
  /** Whether the current analysis came from the clip cache; drives the Meta wording. */
  analysisCache: AnalysisCacheState["stage"] | null;
  setAnalysisCache: (stage: AnalysisCacheState["stage"] | null) => void;
  /** The studio's single problem line, rendered once as a Notice (DS problem place). */
  analysisProblem: {title: string; detail: string} | null;
  setAnalysisProblem: (problem: {title: string; detail: string} | null) => void;
  /** Measured geometry collected so far, one entry per measured shot (the Geometry module reads it). */
  analysisGeometries: ShotGeometry[];
  setAnalysisGeometries: (geometries: ShotGeometry[]) => void;
  /**
   * Why a shot was not measured, per shot index: a decided "no person" shot is skipped
   * before the geometry request, and a real geometry refusal (a floor, a foot point) is
   * recorded here instead of one screen-wide Notice. The Geometry module shows the reason.
   */
  analysisShotNotes: Record<number, string>;
  setAnalysisShotNotes: (notes: Record<number, string>) => void;
  /** Shots deliberately left as blockout (no person / no floor); cached so a repeat run does not retry them. */
  analysisSkips: ShotSkip[];
  setAnalysisSkips: (skips: ShotSkip[]) => void;
  /** The shot whose actions popup (still, Make it real) is open, or "". Owned by the shell so its
   *  main "Render shot" action and a module's timeline arrow open the same popup. */
  shotActions: string;
  openShotActions: (shotId: string) => void;
  closeShotActions: () => void;
};

/** "16:9" style label for a scene aspect ratio. */
export function aspectText(score: StageScore): string {
  const ratio = score.aspectRatio;
  for (const [value, label] of [[16 / 9, "16:9"], [21 / 9, "21:9"], [4 / 3, "4:3"], [1, "1:1"]] as const) {
    if (Math.abs(ratio - value) < 0.01) return label;
  }
  return `${ratio.toFixed(2)}:1`;
}

/** What the timeline is synced against, in the words the reference app uses. */
export function referenceLabel(reference: ReferenceSource): string {
  if (reference.kind === "youtube") return "YouTube sync";
  if (reference.kind === "file") return "Clip sync";
  if (reference.kind === "procedural") return "Procedural clock";
  return "No reference";
}

/** A part of a YouTube video in its own seconds. */
export type YoutubeSection = {startSec: number; endSec: number};

/** Without an end, a section from t= is this long: enough for a few shots, cheap to analyse. */
export const YOUTUBE_SECTION_SEC = 10;

const youtubeSeconds = (value: string | null): number | null => {
  if (!value) return null;
  const clock = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/.exec(value.trim());
  if (!clock || !value.trim()) return null;
  const seconds = Number(clock[1] ?? 0) * 3600 + Number(clock[2] ?? 0) * 60 + Number(clock[3] ?? 0);
  return Number.isFinite(seconds) ? seconds : null;
};

/**
 * The section a YouTube link asks for: t= or start= (seconds or 1m23s) and an optional end=. A link
 * without a start is the whole video (undefined); a start without an end is YOUTUBE_SECTION_SEC long.
 */
export function youtubeSection(input: string): YoutubeSection | undefined {
  let params: URLSearchParams;
  try {
    params = new URL(input.trim()).searchParams;
  } catch {
    return undefined;
  }
  const start = youtubeSeconds(params.get("t") ?? params.get("start"));
  if (start === null || start <= 0) return undefined;
  const end = youtubeSeconds(params.get("end"));
  return {startSec: start, endSec: end !== null && end > start ? end : start + YOUTUBE_SECTION_SEC};
}

/** The YouTube id of a watch, share, embed or shorts link, or of a bare id. */
export function youtubeId(input: string): string | null {
  const text = input.trim();
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
    /^([A-Za-z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** The reference a parsed score points at, so opening a score picks up its video. */
export function referenceFromUrl(videoUrl: string): ReferenceSource {
  if (!videoUrl) return {kind: "none"};
  if (videoUrl.startsWith("procedural://")) return {kind: "procedural"};
  const id = youtubeId(videoUrl);
  if (id && /youtu/.test(videoUrl)) {
    const section = youtubeSection(videoUrl);
    return {kind: "youtube", url: videoUrl, videoId: id, ...(section ? {section} : {})};
  }
  if (/^(blob:|https?:|\/media\/)/.test(videoUrl)) return {kind: "file", name: videoUrl.split("/").pop() ?? videoUrl, url: videoUrl};
  return {kind: "none"};
}

/**
 * The word the timeline sections and the shot cards show for one shot. A shot with geometry
 * says how it was obtained ("Measured", or "Estimated (no floor)" when the camera and the
 * distance came from the person's apparent size); a shot without geometry keeps its analysis
 * status (Rough, Measuring, Skipped by note). An edited shot always says "Edited": the person's
 * own score is the fact that matters there, and measured/estimated would be misleading.
 */
export function shotAnalysisLabel(status: ShotStatus | undefined, geometry: ShotGeometry | undefined): string {
  if (status === "edited") return "Edited";
  if (geometry) return geometry.quality === "estimated" ? "Estimated (no floor)" : "Measured";
  return status ? shotStatusLabel(status) : "Not analysed";
}

/**
 * The deterministic edit rule behind the `edited` shot status: comparing the score
 * before and after an explicit apply, a shot counts as edited when its own slice
 * (label, timing, camera cue, per-shot entity overrides and the blocking cues that
 * overlap it) changed. Changing the cast changes every shot's framing, so that
 * marks them all. A different shot count means a new structure, not edits.
 */
export function changedShotIndices(previous: StageScore, next: StageScore): number[] {
  if (previous.shots.length !== next.shots.length) return [];
  const cast = (score: StageScore) =>
    JSON.stringify(score.entities.filter((entity) => entity.kind === "character").map((entity) => [entity.id, entity.label, entity.position, entity.rotation, entity.height]));
  if (cast(previous) !== cast(next)) return next.shots.map((_, index) => index);
  const slice = (score: StageScore, index: number) => {
    const shot = score.shots[index];
    const cues = (score.blocking ?? [])
      .filter((cue) => cue.endSec > shot.startSec - 0.001 && cue.startSec < shot.endSec + 0.001)
      .map((cue) => [cue.entityId, cue.startSec, cue.endSec, cue.fromPosition, cue.position, cue.lookAt ?? null]);
    return JSON.stringify([shot.label, shot.description, shot.startSec, shot.endSec, shot.camera, shot.overrides, cues]);
  };
  const changed: number[] = [];
  for (let index = 0; index < next.shots.length; index++) if (slice(previous, index) !== slice(next, index)) changed.push(index);
  return changed;
}

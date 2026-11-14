/*
 * Local staging: the precise pass after the fast vision-decision blockout.
 * Qwen3-VL (through Ollama) reads one still per shot and returns shot size,
 * camera move, lens, distance, visible people and a description. Everything
 * stays on the machine; there is no cloud provider in this path.
 */
import type {AnalysisPlan} from "./analysis";

export type LocalStagingShot = {
  shot_size: "wide" | "medium" | "close";
  camera_movement: "static" | "dolly" | "pan" | "handheld";
  lens_mm: number;
  distance_m: number;
  people: Array<{label: string; screen: "left" | "center" | "right"}>;
  description: string;
};

export type LocalStagingResult = {model: string; shots: Array<LocalStagingShot | null>; ms: number};

export async function requestLocalStaging(workspaceId: string, frames: string[], model?: string): Promise<LocalStagingResult> {
  const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/reference-staging`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    credentials: "same-origin",
    body: JSON.stringify({frames, ...(model ? {model} : {})}),
    signal: AbortSignal.timeout(300_000),
  });
  const payload = (await response.json().catch(() => null)) as (LocalStagingResult & {error?: string}) | null;
  if (!response.ok || !payload || !Array.isArray(payload.shots)) {
    throw new Error(payload?.error ?? `Local staging failed (${response.status}).`);
  }
  return payload;
}

const MOTION_MANEUVER = {static: "cut", dolly: "dolly", pan: "arc", handheld: "sweep"} as const;
const COLORS = ["#38bdf8", "#f59e0b", "#f472b6", "#a3e635"];

/**
 * Turn per-shot staging results into the scene plan format. People are placed by
 * their screen side (left/centre/right); duplicate labels across shots become one
 * actor, which keeps the cast stable instead of inventing a person per frame.
 */
export function localStagingPlan(shots: Array<LocalStagingShot | null>, indices: number[], title: string): AnalysisPlan {
  const actors: Array<{label: string; side: "left" | "center" | "right"}> = [];
  for (const shot of shots) {
    for (const person of shot?.people ?? []) {
      if (!actors.some((actor) => actor.label.toLowerCase() === person.label.toLowerCase())) actors.push({label: person.label, side: person.screen});
    }
  }
  const entities = actors.slice(0, 4).map((actor, index) => ({
    id: `actor-${String.fromCharCode(97 + index)}`,
    label: actor.label,
    kind: "character" as const,
    position: [actor.side === "left" ? -2.4 : actor.side === "right" ? 2.4 : 0, 0, index === 1 ? 1.2 : index === 2 ? -1.2 : 0],
    rotation: actor.side === "left" ? 30 : actor.side === "right" ? -30 : 0,
    height: 1.75,
    color: COLORS[index % COLORS.length],
  }));
  if (!entities.length) entities.push({id: "actor-a", label: "Actor", kind: "character", position: [0, 0, 0], rotation: 0, height: 1.75, color: COLORS[0]});
  const planShots = shots
    .map((shot, order) => ({shot, index: indices[order] ?? order}))
    .filter((entry): entry is {shot: LocalStagingShot; index: number} => !!entry.shot)
    .sort((left, right) => left.index - right.index)
    .map(({shot, index}) => ({
      label: `${shot.shot_size === "wide" ? "Wide" : shot.shot_size === "close" ? "Close" : "Medium"} shot · ${shot.camera_movement}`,
      camera: {
        target: shot.people.length ? entities[0].id : (entities[0]?.id ?? "actor-a"),
        maneuver: MOTION_MANEUVER[shot.camera_movement],
        distance: shot.distance_m,
        pitch: 8,
        yaw: 0,
        lens: shot.lens_mm,
      },
      _index: index,
    }));
  return {
    title,
    premise: shots.find((shot) => shot?.description)?.description ?? "Local staging reconstruction.",
    stage: {width: 12, depth: 10},
    entities,
    shots: planShots,
  };
}

export type AnalysisCapabilities = {staging: boolean; local: boolean};

/** What this server can do locally; staging is opt-in on small-model setups. */
export async function analysisCapabilities(workspaceId: string): Promise<AnalysisCapabilities> {
  try {
    const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/analysis-capabilities`, {credentials: "same-origin", signal: AbortSignal.timeout(5000)});
    if (!response.ok) return {staging: false, local: true};
    const payload = (await response.json()) as Partial<AnalysisCapabilities>;
    return {staging: payload.staging === true, local: payload.local !== false};
  } catch {
    return {staging: false, local: true};
  }
}

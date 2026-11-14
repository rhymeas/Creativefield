/*
 * Cheap triage between a reference video's shot list and the expensive visual
 * staging pass. This is the layer a decision model (Kev/Jev) would feed: the
 * heuristic here works without any model, and a local decision model replaces
 * or corrects its answers once available (see `askDecisionModel`).
 *
 * The rule is deliberately simple: very short shots get a default camera and
 * no AI frame, long shots get more frames, and at most `maxFrames` shots are
 * described per pass. That is enough to compare the cost of "describe every
 * shot" against "describe the shots that matter".
 */
export type ShotCard = {index: number; start: number; end: number; durationSec: number};

export function buildShotCards(cuts: number[], durationSec: number): ShotCard[] {
  const end = Math.max(0.2, durationSec);
  const inside = cuts.filter((cut) => cut > 0.2 && cut < end - 0.2).sort((left, right) => left - right);
  const bounds = [0, ...inside, end];
  return bounds.slice(1).map((stop, index) => ({index, start: bounds[index], end: stop, durationSec: Math.max(0, stop - bounds[index])}));
}

export type AnalysisPlan = {
  analyze: Array<ShotCard & {frameBudget: number}>;
  skipped: ShotCard[];
  totalFrames: number;
  /** True when the plan describes fewer shots than the clip has. */
  partial: boolean;
  reason: string;
};

export type RouteOptions = {maxFrames?: number; minAnalyzedSec?: number; longShotSec?: number};

/**
 * Choose which shots deserve VLM frames. Large videos are the interesting case:
 * a 76 s promo with 38 shots would otherwise send at most 8 frames and leave 30
 * shots undescribed, or need five sequential VLM calls to cover everything.
 */
export function routeShotAnalysis(cards: ShotCard[], options: RouteOptions = {}): AnalysisPlan {
  const maxFrames = Math.max(1, Math.min(32, options.maxFrames ?? 8));
  // Fast-cut videos are made of short shots: a fixed floor would skip the content.
  // Use the clip's own median shot length so only outliers are skipped.
  const durations = cards.map((card) => card.durationSec).filter((value) => value > 0).sort((left, right) => left - right);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : 0;
  const minAnalyzedSec = Math.max(0.15, Math.min(options.minAnalyzedSec ?? 0.6, median * 0.6));
  const longShotSec = Math.max(minAnalyzedSec, options.longShotSec ?? 3);
  const skipped = cards.filter((card) => card.durationSec < minAnalyzedSec);
  const eligible = cards.filter((card) => card.durationSec >= minAnalyzedSec);
  // Longest first so the frames carry the most staging information, then back to timeline order.
  const chosen = [...eligible]
    .sort((left, right) => right.durationSec - left.durationSec)
    .slice(0, maxFrames)
    .sort((left, right) => left.index - right.index);
  let budgetLeft = maxFrames;
  const analyze = chosen.map((card) => {
    const frameBudget = Math.max(1, Math.min(2, card.durationSec >= longShotSec ? 2 : 1, budgetLeft));
    budgetLeft -= frameBudget;
    return {...card, frameBudget};
  });
  return {
    analyze,
    skipped,
    totalFrames: analyze.reduce((total, card) => total + card.frameBudget, 0),
    partial: analyze.length < cards.length,
    reason: `${analyze.length}/${cards.length} shots selected, ${skipped.length} too short, ${Math.max(0, cards.length - analyze.length)} over the frame budget`,
  };
}

/** Midpoint of each analysed shot in timeline order; one or two frames per shot. */
export function frameTimesForPlan(plan: AnalysisPlan): number[] {
  const times: number[] = [];
  for (const card of plan.analyze) {
    if (card.frameBudget >= 2) times.push(card.start + card.durationSec * 0.35);
    times.push(card.start + card.durationSec * 0.65);
  }
  return times;
}

export type DecisionQuestions = Record<string, {type: "noul" | "choice" | "score"; instructions: string; criteria?: Record<string, string>}>;

/**
 * Ask a local System One-compatible decision model (Kev via Ollama) through the
 * team server. The route reports a setup hint when no model is running, so the
 * studio can fall back to the heuristic above without failing the analysis.
 */
export async function askDecisionModel(
  workspaceId: string,
  state: string,
  questions: DecisionQuestions,
  options: {model?: string; images?: string[]} = {},
): Promise<{answers: Record<string, unknown>; model?: string} | null> {
  try {
    const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/decision`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      credentials: "same-origin",
      body: JSON.stringify({state, questions, ...(options.model ? {model: options.model} : {}), ...(options.images?.length ? {images: options.images} : {})}),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as {answers: Record<string, unknown>; model?: string};
  } catch {
    return null;
  }
}

export type VisionDecision = {people: number; size: "wide" | "medium" | "close"; motion: "static" | "dolly" | "pan" | "handheld"; needsStaging: number};

/** Typed questions for one still frame; all of them are answered in one forward pass. */
export function visionShotQuestions(motion = true): DecisionQuestions {
  return {
    people_count: {type: "choice", instructions: "How many people are clearly visible in this frame?", criteria: {"0": "no people", "1": "one person", "2": "two people", "3": "three people", more: "four or more"}},
    shot_size: {type: "choice", instructions: "What is the shot size?", criteria: {wide: "wide shot showing the space", medium: "medium shot", close: "close-up or detail"}},
    ...(motion ? {movement: {type: "choice" as const, instructions: "What camera movement does this frame suggest?", criteria: {static: "locked off", dolly: "camera moves forward or back", pan: "camera rotates", handheld: "handheld or shaky"}}} : {}),
    needs_staging: {type: "noul", instructions: "Does this frame show people whose positions matter for a blockout?"},
  };
}

/** Read the answer fields of a d3/Kev System One result into our small decision shape. */
export function visionDecisionFromAnswers(answers: Record<string, unknown>): VisionDecision {
  const answer = (name: string) => answers[name] as {choice?: string; noul?: number} | undefined;
  const choice = (name: string, fallback: string) => answer(name)?.choice ?? fallback;
  const count = choice("people_count", "1");
  const people = count === "more" ? 4 : Math.max(0, Math.min(4, Number(count) || 0));
  const size = choice("shot_size", "medium");
  const motion = choice("movement", "static");
  return {
    people,
    size: size === "wide" || size === "close" ? size : "medium",
    motion: motion === "dolly" || motion === "pan" || motion === "handheld" ? motion : "static",
    needsStaging: typeof answer("needs_staging")?.noul === "number" ? Number(answer("needs_staging")?.noul) : 0.5,
  };
}

const SIZE_CAMERA = {
  wide: {distance: 7, lens: 35, label: "Wide shot"},
  medium: {distance: 4, lens: 50, label: "Medium shot"},
  close: {distance: 2, lens: 85, label: "Close shot"},
} as const;
const MOTION_MANEUVER = {static: "cut", dolly: "dolly", pan: "arc", handheld: "sweep"} as const;

/**
 * Build a scene plan from vision decisions for the shots the triage selected.
 * It is deliberately small: cast size, shot size, camera move and a label; the
 * expensive staging pass can replace it later.
 */
export function visionPlanFromDecisions(
  decisions: Array<{index: number; decision: VisionDecision}>,
  title: string,
): import("./analysis").AnalysisPlan {
  const maxPeople = Math.min(4, decisions.reduce((max, entry) => Math.max(max, entry.decision.people), 0));
  const entities = Array.from({length: Math.max(1, maxPeople)}, (_, index) => ({
    id: `actor-${String.fromCharCode(97 + index)}`,
    label: maxPeople === 1 ? "Actor" : `Actor ${String.fromCharCode(65 + index)}`,
    kind: "character" as const,
    position: [index === 0 ? -1.2 : index === 1 ? 1.2 : 0, 0, 0],
    rotation: 0,
    height: 1.75,
    color: ["#38bdf8", "#f59e0b", "#f472b6", "#a3e635"][index % 4],
  }));
  const shots = [...decisions]
    .sort((left, right) => left.index - right.index)
    .map(({decision}) => {
      const camera = SIZE_CAMERA[decision.size];
      return {
        label: `${camera.label} · ${decision.motion}`,
        camera: {
          target: entities[0]?.id ?? "actor-a",
          maneuver: MOTION_MANEUVER[decision.motion],
          distance: camera.distance,
          pitch: 8,
          yaw: 0,
          lens: camera.lens,
        },
      };
    });
  return {title, premise: "Fast blockout from local vision decisions (d3).", stage: {width: 12, depth: 10}, entities, shots};
}

/** One local decision request per sampled frame; sequential so one GPU model serves them. */
export async function decideShotsWithVision(
  workspaceId: string,
  frames: string[],
  indices: number[],
  model?: string,
): Promise<{decisions: Array<{index: number; decision: VisionDecision}>; ms: number} | null> {
  if (!frames.length) return null;
  const started = performance.now();
  const decisions: Array<{index: number; decision: VisionDecision}> = [];
  for (const [index, frame] of frames.entries()) {
    const result = await askDecisionModel(workspaceId, "One still frame from a reference video shot.", visionShotQuestions(), {...(model ? {model} : {}), images: [frame]});
    if (!result) return null;
    decisions.push({index: indices[index] ?? index, decision: visionDecisionFromAnswers(result.answers)});
  }
  return {decisions, ms: Math.round(performance.now() - started)};
}

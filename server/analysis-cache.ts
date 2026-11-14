/*
 * The reference-analysis cache in Postgres: one row per (workspace, cache key),
 * where the key is the clip's SHA-256 plus the analysis params
 * (see src/film-studio/analysis-contract.ts). Each stage owns its own column, so
 * a decisions commit can never clear stored geometries and a score commit never
 * clears the shot list. `stages` records which stages are present, `timings` the
 * measured cost of the server stages.
 *
 * Every write is a read-merge-write: the studio commits stages one at a time
 * (decision batches, geometry batches, then the final score), and this module
 * merges per shot index instead of replacing the whole row. The studio owns the
 * score text; when it commits one, this module derives the stored score hash
 * with the same pure function both sides use, so identical scores always hash
 * identically.
 */
import type {Pool} from "pg";
import {
  scoreHash,
  type AnalysisParams,
  type AnalysisShot,
  type AnalysisTimings,
  type ClipFacts,
  type PendingStages,
  type ShotDecision,
  type ShotGeometry,
  type ShotSkip,
} from "../src/film-studio/analysis-contract";
import type {ShotStatus} from "../src/film-studio/shot-status";

/** Which server stages are present for a cached analysis. */
export type AnalysisStages = {
  pyramid?: boolean;
  cuts?: boolean;
  keyframes?: boolean;
  decisions?: boolean;
  geometry?: boolean;
  score?: boolean;
};

export type StoredAnalysis = {
  cacheKey: string;
  clip: ClipFacts | null;
  params: AnalysisParams | null;
  shots: AnalysisShot[];
  decisions: ShotDecision[];
  geometries: ShotGeometry[];
  skips: ShotSkip[];
  scoreYaml: string;
  scoreHash: string;
  statuses: ShotStatus[];
  stages: AnalysisStages;
  timings: Partial<AnalysisTimings>;
  updatedAt: string;
};

/** One stage write; every field is optional and absent fields keep their stored value. */
export type AnalysisCachePatch = {
  clip?: ClipFacts | null;
  params?: AnalysisParams | null;
  shots?: AnalysisShot[];
  decisions?: ShotDecision[];
  geometries?: ShotGeometry[];
  skips?: ShotSkip[];
  scoreYaml?: string;
  scoreHash?: string;
  statuses?: ShotStatus[];
  stages?: AnalysisStages;
  timings?: Partial<AnalysisTimings>;
};

const COLUMNS = "cache_key, clip, params, shots, decisions, geometries, skips, score_yaml, score_hash, statuses, stages, timings, updated_at";

function objects<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function object<T extends object>(value: unknown): T | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null;
}

/** Map one pg row to the stored shape; jsonb comes back already parsed. */
export function rowToStoredAnalysis(row: Record<string, unknown>): StoredAnalysis {
  const updatedAt = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? "");
  return {
    cacheKey: String(row.cache_key ?? ""),
    clip: object<ClipFacts>(row.clip),
    params: object<AnalysisParams>(row.params),
    shots: objects<AnalysisShot>(row.shots),
    decisions: objects<ShotDecision>(row.decisions),
    geometries: objects<ShotGeometry>(row.geometries),
    skips: objects<ShotSkip>(row.skips),
    scoreYaml: typeof row.score_yaml === "string" ? row.score_yaml : "",
    scoreHash: typeof row.score_hash === "string" ? row.score_hash : "",
    statuses: objects<ShotStatus>(row.statuses),
    stages: object<AnalysisStages>(row.stages) ?? {},
    timings: object<Partial<AnalysisTimings>>(row.timings) ?? {},
    updatedAt,
  };
}

/** Merge per shot index, keeping the order stable so a diff between two commits is small. */
function mergeByShotIndex<T extends {shotIndex: number}>(existing: readonly T[], incoming: readonly T[] | undefined): T[] {
  if (!incoming?.length) return [...existing];
  const merged = new Map<number, T>();
  for (const item of existing) merged.set(item.shotIndex, item);
  for (const item of incoming) merged.set(item.shotIndex, item);
  return [...merged.values()].sort((left, right) => left.shotIndex - right.shotIndex);
}

/**
 * Pure merge of one stage patch into the stored analysis. A missing (undefined)
 * patch field keeps the stored value; an explicitly empty score keeps the stored
 * score. Decisions and geometries merge per shot index because the studio writes
 * them in batches of eight.
 */
export function mergeAnalysisCache(existing: StoredAnalysis | null, cacheKey: string, patch: AnalysisCachePatch): StoredAnalysis {
  const base: StoredAnalysis = existing ?? {
    cacheKey,
    clip: null,
    params: null,
    shots: [],
    decisions: [],
    geometries: [],
    skips: [],
    scoreYaml: "",
    scoreHash: "",
    statuses: [],
    stages: {},
    timings: {},
    updatedAt: "",
  };
  const incomingScore = typeof patch.scoreYaml === "string" && patch.scoreYaml.trim() ? patch.scoreYaml : "";
  const scoreYaml = incomingScore || base.scoreYaml;
  const incomingHash = typeof patch.scoreHash === "string" && patch.scoreHash ? patch.scoreHash : "";
  const hash = incomingScore ? incomingHash || scoreHash(incomingScore) : base.scoreHash || (scoreYaml ? scoreHash(scoreYaml) : "");
  const shots = patch.shots?.length ? patch.shots : base.shots;
  const statuses = patch.statuses?.length ? patch.statuses : base.statuses;
  const decisions = mergeByShotIndex(base.decisions, patch.decisions);
  const geometries = mergeByShotIndex(base.geometries, patch.geometries);
  const skips = mergeByShotIndex(base.skips, patch.skips);
  return {
    cacheKey,
    clip: patch.clip !== undefined ? patch.clip : base.clip,
    params: patch.params !== undefined ? patch.params : base.params,
    shots,
    decisions,
    geometries,
    skips,
    scoreYaml,
    scoreHash: hash,
    statuses,
    stages: {
      ...base.stages,
      ...(patch.stages ?? {}),
      ...(incomingScore ? {score: true} : {}),
      ...(shots.length ? {decisions: coverageComplete(shots, decisions), geometry: coverageComplete(shots, [...geometries, ...skips])} : {}),
    },
    timings: {...base.timings, ...definedTimings(patch.timings)},
    updatedAt: new Date().toISOString(),
  };
}

function definedTimings(timings: Partial<AnalysisTimings> | undefined): Partial<AnalysisTimings> {
  if (!timings) return {};
  const out: Partial<AnalysisTimings> = {};
  for (const [key, value] of Object.entries(timings)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key as keyof AnalysisTimings] = value;
  }
  return out;
}

function coveredShots(items: readonly {shotIndex: number}[]): Set<number> {
  return new Set(items.map((item) => item.shotIndex));
}

function coverageComplete(shots: readonly AnalysisShot[], items: readonly {shotIndex: number}[]): boolean {
  return shots.length > 0 && coveredShots(items).size >= shots.length;
}

/** Which stages the studio still has to run for this cached clip. */
export function analysisPending(stored: Pick<StoredAnalysis, "shots" | "decisions" | "geometries"> & {skips?: ShotSkip[]}): PendingStages {
  const coveredDecisions = coveredShots(stored.decisions).size;
  // A deliberately skipped shot counts as covered: keeps it as a blockout forever.
  const coveredGeometry = coveredShots([...stored.geometries, ...(stored.skips ?? [])]).size;
  return {
    decisions: coveredDecisions < stored.shots.length,
    geometry: coveredGeometry < stored.shots.length,
  };
}

/** full = the cached score is usable as-is; partial = only cuts/frames are cached. */
export function analysisCacheStage(stored: Pick<StoredAnalysis, "scoreYaml">): "full" | "partial" {
  return stored.scoreYaml.trim() ? "full" : "partial";
}

/** True when every stage the contract knows about is stored for every shot. */
export function analysisComplete(stored: Pick<StoredAnalysis, "scoreYaml" | "shots" | "decisions" | "geometries"> & {skips?: ShotSkip[]}): boolean {
  const pending = analysisPending(stored);
  return stored.scoreYaml.trim().length > 0 && !pending.decisions && !pending.geometry;
}

/** One cached row, or null when this clip and these params were never analysed. */
export async function readAnalysisCache(pool: Pool, workspaceId: string, cacheKey: string): Promise<StoredAnalysis | null> {
  const result = await pool.query(`SELECT ${COLUMNS} FROM reference_analysis_cache WHERE workspace_id=$1 AND cache_key=$2`, [workspaceId, cacheKey]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToStoredAnalysis(row) : null;
}

/**
 * Write one stage (or several) for a cached clip. Existing stages are read first
 * and merged per shot index, so committing decisions keeps cached geometries.
 */
export async function upsertAnalysisCache(pool: Pool, workspaceId: string, cacheKey: string, patch: AnalysisCachePatch): Promise<StoredAnalysis> {
  const existing = await readAnalysisCache(pool, workspaceId, cacheKey);
  const merged = mergeAnalysisCache(existing, cacheKey, patch);
  const json = (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value));
  await pool.query(
    `INSERT INTO reference_analysis_cache
       (workspace_id, cache_key, clip, params, shots, decisions, geometries, skips, score_yaml, score_hash, statuses, stages, timings, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, now())
     ON CONFLICT (workspace_id, cache_key) DO UPDATE SET
       clip = EXCLUDED.clip,
       params = EXCLUDED.params,
       shots = EXCLUDED.shots,
       decisions = EXCLUDED.decisions,
       geometries = EXCLUDED.geometries,
       skips = EXCLUDED.skips,
       score_yaml = EXCLUDED.score_yaml,
       score_hash = EXCLUDED.score_hash,
       statuses = EXCLUDED.statuses,
       stages = EXCLUDED.stages,
       timings = EXCLUDED.timings,
       updated_at = now()`,
    [
      workspaceId,
      cacheKey,
      json(merged.clip),
      json(merged.params),
      json(merged.shots),
      json(merged.decisions),
      json(merged.geometries),
      json(merged.skips),
      merged.scoreYaml,
      merged.scoreHash,
      json(merged.statuses),
      json(merged.stages),
      json(merged.timings),
    ],
  );
  return merged;
}

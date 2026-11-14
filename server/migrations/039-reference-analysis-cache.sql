-- Reference analysis cache: one row per (workspace, clip SHA-256 + analysis params).
-- A clip is identified by its content hash, so the same upload always resolves to the same
-- row and the studio gets the same score back. Each stage (pyramid, decisions, geometry,
-- score) is stored in its own column; committing one stage never clears another.
CREATE TABLE reference_analysis_cache (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 cache_key text NOT NULL,
 clip jsonb,
 params jsonb,
 shots jsonb NOT NULL DEFAULT '[]'::jsonb,
 decisions jsonb NOT NULL DEFAULT '[]'::jsonb,
 geometries jsonb NOT NULL DEFAULT '[]'::jsonb,
 score_yaml text NOT NULL DEFAULT '',
 score_hash text NOT NULL DEFAULT '',
 statuses jsonb NOT NULL DEFAULT '[]'::jsonb,
 stages jsonb NOT NULL DEFAULT '{}'::jsonb,
 timings jsonb NOT NULL DEFAULT '{}'::jsonb,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (workspace_id, cache_key)
);

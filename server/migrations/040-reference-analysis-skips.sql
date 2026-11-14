-- Deliberately unmeasured shots live next to the cached geometries, so a repeated analysis
-- does not retry shots that have no person or no usable floor. One row per clip.
ALTER TABLE reference_analysis_cache ADD COLUMN IF NOT EXISTS skips jsonb NOT NULL DEFAULT '[]'::jsonb;

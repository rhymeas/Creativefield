-- A run records what was produced and which inputs it used, so a result is deleted by hiding the run:
-- the record stays as history. The partial index keeps the visible runs list cheap.
ALTER TABLE runs ADD COLUMN deleted_at timestamptz;
CREATE INDEX runs_visible ON runs(workspace_id, project_id, created_at DESC) WHERE deleted_at IS NULL;

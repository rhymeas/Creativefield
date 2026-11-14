-- Reference snapshots are append-only, so a character cannot be hard-deleted without losing the
-- provenance of every shot it produced. Removing one therefore hides it: the record stays as history.
ALTER TABLE character_records ADD COLUMN archived_at timestamptz;
CREATE INDEX character_records_visible ON character_records(workspace_id, project_id, created_at DESC)
  WHERE archived_at IS NULL;

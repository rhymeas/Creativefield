-- A deletion receipt survives a filesystem failure so an authorized retry can
-- finish cleanup after the asset disappears from the public library.
CREATE TABLE asset_deletions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL,
  project_id uuid,
  name text NOT NULL,
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, asset_id)
);
CREATE INDEX asset_deletions_pending_project ON asset_deletions(workspace_id,project_id,created_at) WHERE completed_at IS NULL;

CREATE TABLE placement_drafts (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  project_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  draft jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, project_id, asset_id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships (workspace_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, asset_id) REFERENCES assets (workspace_id, id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(draft) = 'object')
);

CREATE INDEX placement_drafts_project_updated_idx
  ON placement_drafts (workspace_id, project_id, updated_at DESC);

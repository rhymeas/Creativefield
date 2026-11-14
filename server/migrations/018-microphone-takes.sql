CREATE TABLE microphone_takes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  asset_id uuid NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,project_id,created_by,idempotency_key),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id),
  FOREIGN KEY(workspace_id,asset_id) REFERENCES assets(workspace_id,id)
);
CREATE TRIGGER microphone_takes_append_only BEFORE UPDATE OR DELETE ON microphone_takes FOR EACH ROW EXECUTE FUNCTION reject_character_reference_mutation();

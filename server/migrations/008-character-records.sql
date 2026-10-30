ALTER TABLE elements ADD CONSTRAINT elements_workspace_id_kind_key UNIQUE(workspace_id,id,kind);

CREATE TABLE character_records (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL,
  element_id uuid NOT NULL,
  element_kind text NOT NULL DEFAULT 'character' CHECK(element_kind='character'),
  name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK(char_length(description) <= 20000),
  idempotency_key text NOT NULL CHECK(char_length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK(char_length(request_hash) = 64),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,project_id,idempotency_key),
  UNIQUE(workspace_id,element_id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id),
  FOREIGN KEY(workspace_id,element_id,element_kind) REFERENCES elements(workspace_id,id,kind)
);

CREATE TABLE character_reference_snapshots (
  workspace_id uuid NOT NULL,
  character_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal >= 0 AND ordinal < 16),
  asset_id uuid NOT NULL,
  asset_project_id uuid,
  asset_sha256 text NOT NULL,
  asset_media_type text NOT NULL CHECK(asset_media_type IN ('image','reference')),
  asset_content_type text NOT NULL,
  asset_bytes bigint NOT NULL CHECK(asset_bytes >= 0),
  asset_metadata jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY(workspace_id,character_id,ordinal),
  UNIQUE(workspace_id,character_id,asset_id),
  FOREIGN KEY(workspace_id,character_id) REFERENCES character_records(workspace_id,id),
  FOREIGN KEY(workspace_id,asset_id) REFERENCES assets(workspace_id,id),
  FOREIGN KEY(workspace_id,asset_project_id) REFERENCES projects(workspace_id,id)
);

CREATE INDEX character_records_project ON character_records(workspace_id,project_id,created_at,id);

CREATE FUNCTION reject_character_reference_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'character reference snapshots are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER character_reference_snapshots_append_only
  BEFORE UPDATE OR DELETE ON character_reference_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_character_reference_mutation();

CREATE TRIGGER character_reference_snapshots_append_only_truncate
  BEFORE TRUNCATE ON character_reference_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION reject_character_reference_mutation();

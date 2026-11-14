-- AUD-01b: append-only provenance records for scripts and voice elements.
-- Persistence only: no TTS, rendering or lip-sync execution is implied.

CREATE TABLE script_revisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision > 0),
  language text NOT NULL CHECK(char_length(btrim(language)) BETWEEN 1 AND 35),
  record jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,project_id,revision),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id)
);

CREATE TABLE voice_element_revisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision > 0),
  engine text NOT NULL CHECK(char_length(btrim(engine)) BETWEEN 1 AND 120),
  model text NOT NULL CHECK(char_length(btrim(model)) BETWEEN 1 AND 120),
  record jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,project_id,revision),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id)
);

CREATE INDEX script_revisions_project ON script_revisions(workspace_id,project_id,revision DESC);
CREATE INDEX voice_element_revisions_project ON voice_element_revisions(workspace_id,project_id,revision DESC);

CREATE FUNCTION reject_voice_record_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'voice provenance records are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER script_revisions_append_only
  BEFORE UPDATE OR DELETE ON script_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_voice_record_mutation();

CREATE TRIGGER script_revisions_append_only_truncate
  BEFORE TRUNCATE ON script_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_voice_record_mutation();

CREATE TRIGGER voice_element_revisions_append_only
  BEFORE UPDATE OR DELETE ON voice_element_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_voice_record_mutation();

CREATE TRIGGER voice_element_revisions_append_only_truncate
  BEFORE TRUNCATE ON voice_element_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_voice_record_mutation();

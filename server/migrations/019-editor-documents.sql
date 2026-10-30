CREATE TABLE editor_documents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('saved','recovery')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id,project_id) REFERENCES projects(workspace_id,id)
);
CREATE INDEX editor_documents_project ON editor_documents(workspace_id,project_id,updated_at DESC);

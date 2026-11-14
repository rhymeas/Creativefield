CREATE TABLE user_workflows (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  label text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);

CREATE TABLE user_workflow_revisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES user_workflows(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  manifest jsonb NOT NULL,
  template jsonb NOT NULL,
  mapping jsonb NOT NULL,
  source_name text NOT NULL,
  source_sha256 text NOT NULL,
  graph_sha256 text NOT NULL,
  published boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);

CREATE UNIQUE INDEX user_workflow_one_published
  ON user_workflow_revisions (workflow_id)
  WHERE published;

CREATE INDEX user_workflow_revisions_workspace
  ON user_workflow_revisions (workspace_id, workflow_id, version DESC);

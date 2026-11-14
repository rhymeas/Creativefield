-- A rerun keeps its editor changes separate from the submitted graph and the
-- immutable capability revision. Both graphs here are the public editor view.
CREATE TABLE run_graph_edits (
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  source_run_id uuid NOT NULL,
  original_graph jsonb NOT NULL,
  edited_graph jsonb NOT NULL,
  PRIMARY KEY (workspace_id, run_id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs(workspace_id, id),
  FOREIGN KEY (workspace_id, source_run_id) REFERENCES runs(workspace_id, id)
);

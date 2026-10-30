-- Approval belongs to a frozen image/run/input context; it never queues animation.
CREATE TABLE replace_anchor_reviews (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  run_id uuid NOT NULL REFERENCES runs(id),
  context_digest text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  reviewed_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,run_id)
);

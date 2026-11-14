ALTER TABLE provider_connections ADD COLUMN credential_revision bigint NOT NULL DEFAULT 1;
CREATE TABLE provider_run_bindings (
 workspace_id uuid NOT NULL, run_id uuid NOT NULL, manifest jsonb NOT NULL,
 binding jsonb NOT NULL, binding_hash text NOT NULL,
 connection_id uuid NOT NULL, credential_revision bigint NOT NULL,
 request_token uuid NOT NULL UNIQUE,
 phase text NOT NULL DEFAULT 'not_started' CHECK(phase IN ('not_started','preparing','submit_started','accepted')),
 cancel_attempted boolean NOT NULL DEFAULT false,
 next_poll_at timestamptz NOT NULL DEFAULT now(), poll_failures integer NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,run_id),
 FOREIGN KEY(workspace_id,run_id) REFERENCES runs(workspace_id,id)
);

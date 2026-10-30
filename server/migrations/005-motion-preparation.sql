-- Durable, restart-safe preparation ledger for the Wan Animate motion-transfer
-- route (EDT-04b2). One row per run. The run stays in `pending` while local
-- FFmpeg normalization runs; no transaction is held across media work. The
-- post_attempted_at marker is set in the same transaction that persists the
-- compiled graph, immediately before the first HTTP POST to ComfyUI, and is
-- never cleared: once set, an ambiguous submission is reconciled, never
-- automatically resubmitted.
CREATE TABLE motion_preparations (
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','preparing','prepared','submitted','failed','canceled')),
  normalization_version integer NOT NULL DEFAULT 1 CHECK(normalization_version>=1),
  source_asset_id uuid,
  source_storage_key text CHECK(source_storage_key IS NULL OR source_storage_key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'),
  source_sha256 text CHECK(source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  source_bytes bigint CHECK(source_bytes IS NULL OR source_bytes>0),
  normalized_storage_key text CHECK(normalized_storage_key IS NULL OR normalized_storage_key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'),
  normalized_sha256 text CHECK(normalized_sha256 IS NULL OR normalized_sha256 ~ '^[0-9a-f]{64}$'),
  normalized_bytes bigint CHECK(normalized_bytes IS NULL OR normalized_bytes>0),
  receipt jsonb,
  graph_digest text CHECK(graph_digest IS NULL OR graph_digest ~ '^[0-9a-f]{64}$'),
  post_attempted_at timestamptz,
  attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0),
  lease_owner text,
  lease_expires_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,run_id),
  FOREIGN KEY(workspace_id,run_id) REFERENCES runs(workspace_id,id),
  FOREIGN KEY(workspace_id,source_asset_id) REFERENCES assets(workspace_id,id),
  CHECK(state NOT IN ('prepared','submitted') OR (receipt IS NOT NULL AND normalized_storage_key IS NOT NULL AND normalized_sha256 IS NOT NULL AND source_sha256 IS NOT NULL)),
  CHECK(state<>'submitted' OR (post_attempted_at IS NOT NULL AND graph_digest IS NOT NULL)),
  CHECK((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK(state='preparing' OR lease_owner IS NULL)
);
CREATE INDEX motion_preparations_recovery ON motion_preparations(state,lease_expires_at);

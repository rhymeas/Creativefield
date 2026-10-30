-- Image editing needs more than the legacy single parent_id: an artifact can
-- depend on an ordered set of sources, masks and layers.  The project_id is
-- repeated deliberately so both foreign keys prove that every relation stays
-- inside one project (and one workspace).
ALTER TABLE assets
  ADD CONSTRAINT assets_workspace_project_id_id_key UNIQUE(workspace_id,project_id,id);

ALTER TABLE runs
  ADD CONSTRAINT runs_workspace_project_id_id_key UNIQUE(workspace_id,project_id,id);

CREATE TABLE asset_relations (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  related_asset_id uuid NOT NULL,
  role text NOT NULL CHECK(role ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  ordinal integer NOT NULL CHECK(ordinal>=0),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,asset_id,role,ordinal),
  UNIQUE(workspace_id,asset_id,related_asset_id,role),
  CHECK(asset_id<>related_asset_id),
  FOREIGN KEY(workspace_id,project_id,asset_id)
    REFERENCES assets(workspace_id,project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,project_id,related_asset_id)
    REFERENCES assets(workspace_id,project_id,id) ON DELETE RESTRICT
);

CREATE INDEX asset_relations_related
  ON asset_relations(workspace_id,project_id,related_asset_id,role,ordinal);

-- Slots are written before artifact publication. slot_id and asset_id are
-- deterministic application-derived UUIDs, so a restarted reconciler targets
-- the same rows and asset identities. Staging data remains durable across a
-- process failure; published_asset_id is the project-scoped referential proof.
CREATE TABLE run_artifact_slots (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  role text NOT NULL CHECK(role ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  ordinal integer NOT NULL CHECK(ordinal>=0),
  media_type text NOT NULL CHECK(media_type IN ('image','mask','layer')),
  state text NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','staged','published','discarded')),
  staged_storage_key text,
  staged_content_type text,
  staged_sha256 text CHECK(staged_sha256 IS NULL OR staged_sha256 ~ '^[a-f0-9]{64}$'),
  staged_bytes bigint CHECK(staged_bytes IS NULL OR staged_bytes>0),
  staged_name text,
  staged_metadata jsonb,
  staged_relations jsonb,
  published_asset_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,slot_id),
  UNIQUE(workspace_id,run_id,role,ordinal),
  UNIQUE(workspace_id,asset_id),
  CHECK(published_asset_id IS NULL OR published_asset_id=asset_id),
  CHECK(
    state='planned' OR state='discarded' OR
    (staged_storage_key IS NOT NULL AND staged_content_type='image/png' AND
     staged_sha256 IS NOT NULL AND staged_bytes IS NOT NULL AND
     staged_name IS NOT NULL AND staged_metadata IS NOT NULL AND staged_relations IS NOT NULL)
  ),
  CHECK(state<>'published' OR published_asset_id IS NOT NULL),
  FOREIGN KEY(workspace_id,project_id,run_id)
    REFERENCES runs(workspace_id,project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,project_id,published_asset_id)
    REFERENCES assets(workspace_id,project_id,id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX run_artifact_slots_recovery
  ON run_artifact_slots(state,updated_at);

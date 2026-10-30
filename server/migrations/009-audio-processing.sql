CREATE TABLE audio_operations (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES workspaces(id),project_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),
 operation text NOT NULL CHECK(operation IN ('extract','preserve','mute','replace','mix')),
 state text NOT NULL CHECK(state IN ('admitted','probing','processing','validating','publishing','succeeded','failed','cancel_requested','canceled')),
 request jsonb NOT NULL,request_hash text NOT NULL,idempotency_key text NOT NULL,
 video_asset_id uuid NOT NULL,audio_asset_id uuid,
 output_asset_id uuid NOT NULL,
 attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0),
 candidate jsonb,receipt jsonb,error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),UNIQUE(workspace_id,idempotency_key),UNIQUE(workspace_id,output_asset_id),
 FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id),
 FOREIGN KEY(workspace_id,video_asset_id) REFERENCES assets(workspace_id,id),
 FOREIGN KEY(workspace_id,audio_asset_id) REFERENCES assets(workspace_id,id)
);
CREATE TABLE audio_operation_inputs (
 workspace_id uuid NOT NULL,operation_id uuid NOT NULL,asset_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('video','audio')),expected_sha256 text NOT NULL,
 PRIMARY KEY(workspace_id,operation_id,role),
 FOREIGN KEY(workspace_id,operation_id) REFERENCES audio_operations(workspace_id,id),
 FOREIGN KEY(workspace_id,asset_id) REFERENCES assets(workspace_id,id)
);
CREATE TABLE audio_operation_events (
 seq bigserial PRIMARY KEY,workspace_id uuid NOT NULL,operation_id uuid NOT NULL,state text NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,operation_id) REFERENCES audio_operations(workspace_id,id)
);
CREATE INDEX audio_operation_recovery ON audio_operations(state,updated_at);
CREATE INDEX audio_operation_events_workspace ON audio_operation_events(workspace_id,seq);

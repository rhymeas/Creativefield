CREATE TABLE video_frame_inspections (
 workspace_id uuid NOT NULL,
 run_id uuid NOT NULL,
 inspection_version integer NOT NULL,
 source_asset_id uuid NOT NULL,
 result jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,run_id,inspection_version),
 FOREIGN KEY(workspace_id,run_id) REFERENCES runs(workspace_id,id),
 FOREIGN KEY(workspace_id,source_asset_id) REFERENCES assets(workspace_id,id)
);

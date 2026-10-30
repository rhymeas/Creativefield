CREATE TABLE video_extension_jobs (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,project_id uuid NOT NULL,source_asset_id uuid NOT NULL,
 worker_id uuid,created_by uuid NOT NULL REFERENCES users(id),idempotency_key text NOT NULL,request_hash text NOT NULL,
 plan jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','generating','stitching','stitch_failed','succeeded','failed','cancel_requested','canceled')),
 error text,output_asset_id uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),UNIQUE(workspace_id,idempotency_key),
 FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id),
 FOREIGN KEY(workspace_id,source_asset_id) REFERENCES assets(workspace_id,id),
 FOREIGN KEY(workspace_id,worker_id) REFERENCES workers(workspace_id,id),
 FOREIGN KEY(workspace_id,output_asset_id) REFERENCES assets(workspace_id,id)
);

CREATE TABLE video_extension_stages (
 workspace_id uuid NOT NULL,job_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal>=0),
 kind text NOT NULL CHECK(kind IN ('generate','stitch')),
 state text NOT NULL CHECK(state IN ('pending','running','succeeded','failed','canceled')),
 prepared jsonb,child_run_id uuid,input_asset_id uuid,output_asset_id uuid,detail jsonb NOT NULL DEFAULT '{}',
 PRIMARY KEY(workspace_id,job_id,ordinal),UNIQUE(workspace_id,child_run_id),
 FOREIGN KEY(workspace_id,job_id) REFERENCES video_extension_jobs(workspace_id,id),
 FOREIGN KEY(workspace_id,child_run_id) REFERENCES runs(workspace_id,id),
 FOREIGN KEY(workspace_id,input_asset_id) REFERENCES assets(workspace_id,id),
 FOREIGN KEY(workspace_id,output_asset_id) REFERENCES assets(workspace_id,id)
);

CREATE TABLE video_extension_events (
 seq bigserial PRIMARY KEY,workspace_id uuid NOT NULL,job_id uuid NOT NULL,state text NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,job_id) REFERENCES video_extension_jobs(workspace_id,id)
);

CREATE INDEX video_extension_recovery ON video_extension_jobs(state,updated_at);

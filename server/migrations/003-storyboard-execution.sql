CREATE TABLE storyboard_renders (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,project_id uuid NOT NULL,storyboard_id uuid NOT NULL,
 revision integer NOT NULL,worker_id uuid NOT NULL,created_by uuid NOT NULL REFERENCES users(id),
 idempotency_key text NOT NULL,request_hash text NOT NULL,assembly jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','generating','assembling','assembly_failed','succeeded','failed','cancel_requested','canceled')),
 error text,output_asset_id uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id),UNIQUE(workspace_id,idempotency_key),
 FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id),
 FOREIGN KEY(workspace_id,storyboard_id) REFERENCES storyboards(workspace_id,id),
 FOREIGN KEY(workspace_id,worker_id) REFERENCES workers(workspace_id,id),
 FOREIGN KEY(workspace_id,output_asset_id) REFERENCES assets(workspace_id,id)
);
CREATE TABLE storyboard_render_shots (
 workspace_id uuid NOT NULL,render_id uuid NOT NULL,ordinal integer NOT NULL CHECK(ordinal>=0),
 snapshot jsonb NOT NULL,prepared jsonb NOT NULL,workflow_revision_id uuid NOT NULL,
 child_run_id uuid,output_asset_id uuid,
 PRIMARY KEY(workspace_id,render_id,ordinal),UNIQUE(workspace_id,child_run_id),
 FOREIGN KEY(workspace_id,render_id) REFERENCES storyboard_renders(workspace_id,id),
 FOREIGN KEY(workspace_id,workflow_revision_id) REFERENCES workflow_revisions(workspace_id,id),
 FOREIGN KEY(workspace_id,child_run_id) REFERENCES runs(workspace_id,id),
 FOREIGN KEY(workspace_id,output_asset_id) REFERENCES assets(workspace_id,id)
);
CREATE TABLE storyboard_render_events (
 seq bigserial PRIMARY KEY,workspace_id uuid NOT NULL,render_id uuid NOT NULL,state text NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,render_id) REFERENCES storyboard_renders(workspace_id,id)
);
CREATE INDEX storyboard_render_recovery ON storyboard_renders(state,updated_at);

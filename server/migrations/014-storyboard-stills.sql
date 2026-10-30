ALTER TABLE shots ADD COLUMN plan_key uuid;
UPDATE shots SET plan_key=id;
ALTER TABLE shots ALTER COLUMN plan_key SET NOT NULL;
CREATE UNIQUE INDEX shots_plan_key ON shots(workspace_id,storyboard_id,plan_key);

CREATE TABLE storyboard_still_takes (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 storyboard_id uuid NOT NULL,
 plan_key uuid NOT NULL,
 source_revision integer NOT NULL,
 ordinal integer NOT NULL,
 prompt text NOT NULL,
 snapshot jsonb NOT NULL,
 child_run_id uuid NOT NULL,
 batch_key text NOT NULL,
 request_hash text NOT NULL,
 approved_asset_id uuid,
 approved_by uuid,
 approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,storyboard_id) REFERENCES storyboards(workspace_id,id),
 FOREIGN KEY(workspace_id,child_run_id) REFERENCES runs(workspace_id,id),
 FOREIGN KEY(workspace_id,approved_asset_id) REFERENCES assets(workspace_id,id),
 UNIQUE(workspace_id,child_run_id),
 UNIQUE(workspace_id,batch_key,plan_key)
);
CREATE INDEX storyboard_still_history ON storyboard_still_takes(workspace_id,storyboard_id,plan_key,created_at DESC);

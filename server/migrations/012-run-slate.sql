ALTER TABLE runs ADD COLUMN scene smallint, ADD COLUMN shot smallint, ADD COLUMN take integer;
ALTER TABLE runs ADD CONSTRAINT runs_slate_complete CHECK(
  (scene IS NULL AND shot IS NULL AND take IS NULL)
  OR (scene>=1 AND shot>=1 AND take>=1)
);
CREATE UNIQUE INDEX runs_slate_take ON runs(workspace_id,project_id,scene,shot,capability_id,take) WHERE take IS NOT NULL;
CREATE TABLE run_take_counters (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  scene smallint NOT NULL CHECK(scene>=1),
  shot smallint NOT NULL CHECK(shot>=1),
  capability_id text NOT NULL,
  next_take integer NOT NULL CHECK(next_take>=2),
  PRIMARY KEY(workspace_id,project_id,scene,shot,capability_id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id)
);

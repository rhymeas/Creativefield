-- A worker address was unique across the whole database, so only one workspace could ever add
-- https://cloud.comfy.org. On a hosted try-out every guest has a workspace and signs in to Comfy
-- Cloud, so the address is unique per workspace instead.
ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_origin_key;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workers_workspace_origin_key' AND conrelid = 'workers'::regclass) THEN
    ALTER TABLE workers ADD CONSTRAINT workers_workspace_origin_key UNIQUE (workspace_id, origin);
  END IF;
END $$;

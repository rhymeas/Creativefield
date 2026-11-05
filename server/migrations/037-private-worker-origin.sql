-- Only Comfy Cloud is shared by many workspaces (each with its own key). A self-hosted ComfyUI address
-- stays with one workspace, so another workspace cannot register it and read that machine's queue.
CREATE UNIQUE INDEX IF NOT EXISTS workers_private_origin_key ON workers(origin) WHERE kind <> 'cloud';

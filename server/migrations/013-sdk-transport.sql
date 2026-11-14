-- A run freezes the transport that submitted it. Native ComfyUI remains the
-- default; SDK runs go through the local Comfy API v2 proxy and store the
-- proxy job id in remote_id. Existing rows are native.
ALTER TABLE runs ADD COLUMN transport text NOT NULL DEFAULT 'native'
  CHECK (transport IN ('native','sdk'));

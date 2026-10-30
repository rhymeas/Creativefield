-- A worker is either a local ComfyUI server or Comfy Cloud. The worker row
-- never holds a secret: a cloud worker reads COMFY_CLOUD_API_KEY from the
-- environment. Existing rows are local.
ALTER TABLE workers ADD COLUMN kind text NOT NULL DEFAULT 'local'
  CHECK (kind IN ('local','cloud'));

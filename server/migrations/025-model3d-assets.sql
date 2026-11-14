-- Generated 3D models (binary glTF from SaveGLB) are stored as assets like images and videos.
DO $$
DECLARE name text;
BEGIN
  SELECT c.conname INTO name FROM pg_constraint c
  WHERE c.conrelid = 'assets'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%media_type%';
  IF name IS NOT NULL THEN EXECUTE format('ALTER TABLE assets DROP CONSTRAINT %I', name); END IF;
END $$;
ALTER TABLE assets ADD CONSTRAINT assets_media_type_check CHECK (media_type IN ('image','video','audio','mask','layer','reference','timeline','model3d'));

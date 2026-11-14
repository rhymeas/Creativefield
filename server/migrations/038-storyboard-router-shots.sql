-- Storyboard shots may run on Comfy Router: such a render has no ComfyUI worker and its shots no local workflow revision.
ALTER TABLE storyboard_renders ALTER COLUMN worker_id DROP NOT NULL;
ALTER TABLE storyboard_render_shots ALTER COLUMN workflow_revision_id DROP NOT NULL;

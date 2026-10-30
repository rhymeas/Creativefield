-- Journal the normalized-file identity before media publication, including the
-- interval before a complete receipt can be committed.
ALTER TABLE pose_previews ADD COLUMN normalization_candidate_id uuid;
ALTER TABLE pose_previews ADD UNIQUE(workspace_id,normalization_candidate_id);

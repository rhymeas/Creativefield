-- A storyboard carries renders and stills that record what was produced, so it is archived rather than
-- deleted: the board leaves the lists, the record of its films stays.
ALTER TABLE storyboards ADD COLUMN archived_at timestamptz;
CREATE INDEX storyboards_visible ON storyboards(workspace_id, created_at DESC) WHERE archived_at IS NULL;

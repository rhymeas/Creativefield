ALTER TABLE storyboard_still_takes ADD COLUMN rejected_by uuid REFERENCES users(id);
ALTER TABLE storyboard_still_takes ADD COLUMN rejected_at timestamptz;
ALTER TABLE storyboard_still_takes ADD CONSTRAINT storyboard_still_one_decision CHECK(approved_at IS NULL OR rejected_at IS NULL);

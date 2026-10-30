-- A 9:16 story is the one format every social platform asks for. The brief format CHECK is the only
-- place that listed the formats, so it is replaced to admit story_1080x1920. Existing briefs keep theirs.
ALTER TABLE marketing_briefs DROP CONSTRAINT marketing_briefs_format_check;
ALTER TABLE marketing_briefs ADD CONSTRAINT marketing_briefs_format_check
 CHECK(format IN ('square_1080','portrait_1080x1350','landscape_1920x1080','story_1080x1920'));

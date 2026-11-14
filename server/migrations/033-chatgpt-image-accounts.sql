-- Native Codex owns credentials in private, per-user CODEX_HOME directories.
-- This table pins/revokes account associations without storing tokens.
CREATE TABLE chatgpt_image_accounts (
 user_id uuid PRIMARY KEY REFERENCES users(id),
 revision bigint NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE runs DROP CONSTRAINT runs_transport_check;
ALTER TABLE runs ADD CONSTRAINT runs_transport_check CHECK(transport IN ('native','sdk','chatgpt'));

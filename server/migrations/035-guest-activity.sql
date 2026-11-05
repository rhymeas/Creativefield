-- A hosted try-out deletes a guest's workspace after a day without visits; this is when the guest was last seen.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- Provenance stays append-only. The one exception is deleting a whole idle guest workspace, which sets
-- creativefield.guest_cleanup for its own transaction only (server/guest-cleanup.ts).
CREATE OR REPLACE FUNCTION reject_character_reference_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('creativefield.guest_cleanup', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'character reference snapshots are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION reject_voice_record_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('creativefield.guest_cleanup', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'voice provenance records are append-only' USING ERRCODE = '55000';
END;
$$;

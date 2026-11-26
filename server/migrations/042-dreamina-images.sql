-- Dreamina images run through the official CLI with a per-user sign-in profile (route dreamina-native).
ALTER TABLE runs DROP CONSTRAINT runs_transport_check;
ALTER TABLE runs ADD CONSTRAINT runs_transport_check CHECK(transport IN ('native','sdk','chatgpt','dreamina'));

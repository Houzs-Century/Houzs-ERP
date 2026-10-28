-- 0010_member_invite_toggle.sql (Postgres). Mirror of D1 099.
-- Seed the member-invite email channel explicitly ON (was relying on the
-- missing-row default). Idempotent.
INSERT INTO app_settings (key, value) VALUES
  ('email.member_invite', '{"value":true}')
ON CONFLICT (key) DO NOTHING;

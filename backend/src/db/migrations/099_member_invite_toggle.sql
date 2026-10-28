-- 099_member_invite_toggle.sql (D1). Mirror of migrations-pg/0010.
-- Seed the member-invite email channel EXPLICITLY on. It worked before via the
-- "missing row = on" default, but invitations are important enough to pin
-- explicitly (and so the row shows up as a toggle in Settings -> Email).
INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('email.member_invite', '{"value":true}');

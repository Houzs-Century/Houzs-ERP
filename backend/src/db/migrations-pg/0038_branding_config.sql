-- 0038_branding_config.sql (Postgres). Centralise the company identity that was
-- previously hardcoded across ~30 files (backend scan-so/scan-payment/email +
-- frontend PDF libs / Layout / Sidebar / AuthScreens) into ONE editable config
-- the owner manages in Settings.
--
-- Storage: reuse the existing app_settings key/value JSON store (same table the
-- email channel toggles use) rather than introducing a new single-row table —
-- getBranding()/setBranding() read/write the single 'branding' key via the same
-- readSetting/setSetting helpers. The value is a JSON object:
--   { companyName, registrationNo, address, phone, email, website, logoR2Key }
--
-- Idempotent (pg-migrate requirement). The seed carries the CURRENT hardcoded
-- values VERBATIM (frontend pdf-common.ts COMPANY + backend projects_print /
-- assr_print letterhead + email.ts from-address) so NOTHING changes visually —
-- only centralised. ON CONFLICT DO NOTHING keeps an owner's later edits safe on
-- re-run. No new timestamp columns are introduced (app_settings.updated_at is
-- already TEXT, written via the d1-compat shim's datetime('now') — per mig 0008).

INSERT INTO app_settings (key, value) VALUES
  ('branding', '{"companyName":"Houzs Century Sdn Bhd","registrationNo":"202201031135 (1476832-W)","address":"1831-B, Jalan KPB 1, Kawasan Perindustrian Balakong, 43300 Seri Kembangan, Selangor.","phone":"011-1110 8883","email":"hello@houzscentury.com","website":"","logoR2Key":""}')
ON CONFLICT (key) DO NOTHING;

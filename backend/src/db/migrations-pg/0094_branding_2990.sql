-- 0094_branding_2990.sql (Postgres). Per-company branding — seed the 2990
-- company's identity row so documents/PDFs/emails rendered for the 2990
-- company carry 2990's name instead of Houzs Century's.
--
-- Storage follows migration 0038's convention: the app_settings key/value JSON
-- store. HOUZS keeps the legacy 'branding' key (canonical, untouched here);
-- every other company gets 'branding:<CODE>'. getBrandingForCompany()
-- (backend/src/services/branding.ts) resolves company row -> per-company
-- code default, never the HOUZS row.
--
-- companyName mirrors the public.companies master row seeded by 0083
-- ('2990''s Home'). Registration no / address / phone / email are DELIBERATELY
-- blank placeholders: the owner fills them in Settings -> Branding with 2990
-- active in the top-bar company switcher (the branding routes read/write the
-- ACTIVE company's row). Blank letterhead lines are simply omitted on print.
--
-- Idempotent (pg-migrate requirement). ON CONFLICT DO NOTHING keeps the
-- owner's later edits safe on re-run.

INSERT INTO app_settings (key, value) VALUES
  ('branding:2990', '{"companyName":"2990''s Home","registrationNo":"","address":"","phone":"","email":"","website":"","logoR2Key":""}')
ON CONFLICT (key) DO NOTHING;

-- Outbound email identity at retry time: email_outbox rows are drained by the
-- */5 cron with no request context, so the enqueuing send stamps the company
-- code here and the drain re-resolves that company's branding for the From
-- display name. Nullable; NULL = legacy row -> HOUZS identity (unchanged).
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS company_code text;

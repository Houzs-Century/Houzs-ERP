-- 0193_mail_2990_mailbox.sql (Postgres). Wire 2990's mailbox into the Mail
-- Center: hello@2990shome.com (owner ask 2026-07-24).
--
-- Two seeds, both canonical production data (not demo rows):
--   1. branding:2990 email -> hello@2990shome.com. This drives the per-company
--      mailbox-domain check (POST /api/mail-center/addresses), the frontend
--      MailboxesTab domain hint, and the From fallback domain for 2990 sends.
--      The owner's own edits WIN: the update only fires when the email is
--      blank/missing (0094 seeded it deliberately blank because the address
--      was not known then; it is known now).
--   2. email_addresses row for hello@2990shome.com, stamped company 2990, so
--      the inbox exists on deploy. Access grants stay a UI task (Mail Center
--      -> Mailboxes) — this seeds the mailbox, not who may read it.
--
-- Idempotent + re-run-safe: ON CONFLICT DO NOTHING on both inserts; the email
-- update is guarded on "currently blank". The ::jsonb cast only ever touches
-- the single 'branding:2990' key (always writer-serialized JSON — 0094 /
-- setBrandingForCompany), mirroring 0142's fenced pattern.

-- 1a. Fresh/restored DB where 0094's row is absent: seed it WITH the email.
INSERT INTO app_settings (key, value) VALUES
  ('branding:2990', '{"companyName":"2990''s Home","registrationNo":"","address":"","postcode":"","phone":"","email":"hello@2990shome.com","website":"","logoR2Key":""}')
ON CONFLICT (key) DO NOTHING;

-- 1b. Existing row with a blank/missing email: fill it. Any owner-set value is
-- left untouched.
UPDATE app_settings
SET value = jsonb_set(value::jsonb, '{email}', to_jsonb('hello@2990shome.com'::text), true)::text
WHERE key = 'branding:2990'
  AND jsonb_typeof(value::jsonb) = 'object'
  AND COALESCE(value::jsonb->>'email', '') = '';

-- 2. The mailbox row. company_id resolves from the companies master (seeded by
-- 0083); no 2990 row -> no insert (fresh pre-0083 DB), never an error. The
-- unique index is expression-based, lower(address) (0039).
INSERT INTO email_addresses (id, address, label, active, created_at, company_id)
SELECT gen_random_uuid()::text,
       'hello@2990shome.com',
       'General',
       1,
       to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       c.id
FROM companies c
WHERE c.code = '2990'
ON CONFLICT ((lower(address))) DO NOTHING;

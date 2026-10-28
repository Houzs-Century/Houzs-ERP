-- 0126_portal_token_revocation.sql — a kill switch for shared portal links,
-- and the survey TTL the survey route has always claimed to enforce.
--
-- WHY REVOCATION AND NOT A TTL on case_track_tokens: mig 0076 made staff/sales
-- links permanent on an explicit ruling (Nick 2026-07-07, "shared WhatsApp
-- links must keep working forever") and extended every existing row to the
-- far-future stamp. The link is pasted into WhatsApp and a customer reopens it
-- months later to check their case -- that is the flow the ruling protects, and
-- a TTL would silently break it for every customer to fix the rare leaked link.
-- The tokens are 192-bit CSPRNG scoped to one assr_id, so there is no
-- enumeration risk to bound in the first place. The real gap was that a link
-- forwarded to the wrong group could not be killed without hand-editing this
-- table. revoked_at is that kill switch: permanence stays the default, ending a
-- specific link becomes a button instead of a DBA task.
--
-- Nullable with no default and no backfill: NULL means "live", which is true of
-- every existing row, so this is a pure add-column no-op on prod data. Plain
-- ADD COLUMN IF NOT EXISTS (NOT a DO block) -- the pg-migrate runner splits each
-- file on ";\n", which would fragment a dollar-quoted block, and ADD COLUMN IF
-- NOT EXISTS is already idempotent, so the auto-apply on every deploy is a no-op
-- after the first. TEXT written as an ISO string, per the text-timestamp rule
-- mig 0008 established -- NOT timestamptz.
ALTER TABLE case_track_tokens ADD COLUMN IF NOT EXISTS revoked_at text;

-- resolveTrackToken looks up by token (already the PK) and the revoke path
-- updates every live row for one case, which is the assr_id index from mig 0002.
-- No new index: revoked_at is a nullable flag read only after the row is found.

-- ── Survey tokens ────────────────────────────────────────────────────────────
--
-- mig 015 shipped assr_survey_tokens.expires_at documented as "nullable -- null
-- = never expires" and then nothing ever wrote it, so every survey token minted
-- since has been immortal while GET /api/survey/:token answered "Survey not
-- found or expired" -- advertising a check no code performed. The route now
-- enforces expiry and treats NULL as EXPIRED (fail closed: after this backfill a
-- NULL can only mean a mint path that forgot the TTL, which is the bug itself
-- and must not be readable).
--
-- Flipping NULL to fail-closed without this backfill would 404 every outstanding
-- survey link at once, so stamp the existing rows first. created_at + 90 days
-- matches SURVEY_TTL_DAYS in services/assr.ts: a survey is asked for right after
-- the case closes and a rating submitted a year later is noise, while the link
-- sits on an unauthenticated route that echoes customer_name and doc_no. Tokens
-- older than 90 days go dead here -- correct, that is the whole point -- and a
-- recently-closed case keeps the remainder of its window.
--
-- ORDERING IS LOAD-BEARING: deploy.yml runs pg-migrate BEFORE wrangler deploy,
-- so these rows are stamped by the time the fail-closed code is live. The
-- reverse order would 404 every live survey link for the length of the deploy.
--
-- The ADD COLUMN below is not redundant. assr_survey_tokens has no CREATE TABLE
-- anywhere in migrations-pg -- it reached Postgres through the D1 import, and
-- 0000_baseline.sql does not carry it. All the tree proves is that the TABLE
-- exists (0002 indexes it); the only pg-side evidence about its COLUMNS is 0098
-- touching created_at. expires_at is read by no live code -- that is the bug --
-- so its presence on prod cannot be inferred from the app working. Asserting it
-- costs nothing when it is already there and is the difference between a no-op
-- and a failed file that blocks EVERY deploy until someone hand-patches prod.
ALTER TABLE assr_survey_tokens ADD COLUMN IF NOT EXISTS expires_at text;

-- Only unsubmitted rows are worth stamping -- a submitted token is already
-- rejected by the submitted_at check and re-dating it would change nothing.
-- WHERE expires_at IS NULL keeps this idempotent across the every-deploy re-run:
-- once a row is stamped it is never re-stamped, so the window cannot slide
-- forward on each deploy and accidentally make these tokens immortal again.
UPDATE assr_survey_tokens
   SET expires_at = to_char(
         (created_at)::timestamp + interval '90 days',
         'YYYY-MM-DD"T"HH24:MI:SS"Z"'
       )
 WHERE expires_at IS NULL
   AND submitted_at IS NULL
   AND created_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}';

-- The regex, not just `created_at IS NOT NULL`, is what keeps a bad row from
-- taking the whole deploy pipeline down. created_at is TEXT: one unparseable
-- value ('', or anything the D1 import left malformed) makes `::timestamp`
-- throw, which fails this FILE, which blocks EVERY subsequent deploy until
-- someone hand-patches prod -- to fix rows that are already dead weight. The
-- guard admits both stamp formats in the wild ('...T..Z' from mig 0098's
-- default and the older 'YYYY-MM-DD HH:MM:SS' from datetime('now')), since it
-- only pins the leading date. Anything it skips keeps expires_at NULL and the
-- route's fail-closed read retires it -- the safe direction, and the reason
-- this can be a filter rather than a repair.

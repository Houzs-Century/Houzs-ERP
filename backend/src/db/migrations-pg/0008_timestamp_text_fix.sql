-- Corrective: align shim-written timestamp columns to TEXT.
--
-- The whole codebase stores timestamps as text (D1 heritage, e.g.
-- sessions.expires_at) and the d1-compat shim rewrites datetime('now') to
-- to_char(...) which is TEXT. Assigning a text value to a `timestamptz` column
-- fails — but the three writers below wrap their UPDATE in best-effort / the
-- failure was silent, so the write was simply dropped:
--   • email_outbox.sent_at        — sendEmail() + cron drain "mark sent" → row
--     stayed 'pending' → the */5 cron re-sent the same email forever.
--   • users.totp_enrolled_at      — set on 2FA enable → would fail in prod.
--   • position_page_access.updated_at — set on every matrix-editor save.
-- (created_at columns are only ever populated by DEFAULT now() on insert, never
--  via datetime('now'), so they stay timestamptz — no bug there.)
--
-- AMENDMENT 2026-07-17 (comment only — this file is applied and never re-runs).
-- The exemption above is about WRITES, and it is right about writes. It is not a
-- clearance for the column: a timestamptz created_at may still be COMPARED
-- against a shim-rewritten datetime('now'), and that is `timestamptz < text`,
-- which raises. The idempotency-key TTL sweep did exactly that and had never
-- deleted a row -- its .catch swallowed the error for as long as it existed.
-- So: "stays timestamptz" means every datetime('now') that TOUCHES it, on either
-- side of an operator, must be written in PG terms. See backend/src/index.ts's
-- sweep for the corrected shape.
--
-- D1/SQLite already declares all three as TEXT (migs 095/097/094), so there is
-- no D1 counterpart — this purely corrects the PG side. Idempotent: re-running
-- ALTER ... TYPE text on an already-text column is a no-op.

ALTER TABLE email_outbox ALTER COLUMN sent_at TYPE text USING sent_at::text;

ALTER TABLE users ALTER COLUMN totp_enrolled_at TYPE text USING totp_enrolled_at::text;

ALTER TABLE position_page_access ALTER COLUMN updated_at DROP DEFAULT;
ALTER TABLE position_page_access
  ALTER COLUMN updated_at TYPE text USING to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE position_page_access
  ALTER COLUMN updated_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS');

-- One-time data repair: rows that actually delivered but got stuck 'pending'
-- because their "mark sent" UPDATE failed above. A matching 'sent' email_log row
-- proves delivery, so flip them to 'sent' to stop the cron re-sending duplicates.
-- Idempotent (no pending rows match once flipped).
UPDATE email_outbox o
   SET status = 'sent'
 WHERE o.status = 'pending'
   AND EXISTS (
     SELECT 1 FROM email_log l
      WHERE l.to_addr = o.to_address
        AND l.subject = o.subject
        AND l.status = 'sent'
   );

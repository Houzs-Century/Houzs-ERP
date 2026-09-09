-- 20260903T1237_contractor_share_tokens.sql
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   Creates `contractor_share_tokens` — the unguessable token behind each
--   contractor's public, no-login calendar share link. One live token per
--   contractor NAME (matching the free-text `projects.contractor` value the
--   link filters on). `revoked_at` is the kill switch for a leaked link
--   (pattern: mig 0126 case-track revocation). Text timestamps like the rest
--   of `public` (mig 0008). Additive + idempotent (CREATE TABLE IF NOT EXISTS),
--   so re-running is a no-op and no existing row is touched.
--
-- Reversal: DROP TABLE IF EXISTS contractor_share_tokens;
-- Verified against: prod Supabase anogrigyjbduyzclzjgn (project_contractors column shape reused; DDL proven in a rolled-back txn)

CREATE TABLE IF NOT EXISTS contractor_share_tokens (
  token       text PRIMARY KEY,
  contractor  text NOT NULL,
  revoked_at  text,
  created_by  bigint,
  created_at  text DEFAULT to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text)
);

-- Resolve-by-contractor for the admin "current link" lookup. No index on the
-- revoked flag (mig 0126 rationale: a boolean is not selective).
CREATE INDEX IF NOT EXISTS idx_contractor_share_tokens_contractor
  ON contractor_share_tokens(contractor);

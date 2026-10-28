-- 081_assr_verification.sql
--
-- Verification card on the ASSR case detail (decided 2026-05-21).
--
-- The Under Verification → Pending Solution transition was the only
-- weakly-triggered row in the stage matrix — the original proposal had
-- "page opened" as the predicate, which is a passive read and doesn't
-- capture the *acceptance decision* the stage represents.
--
-- This migration adds the structured fields QA actually decides on,
-- so the auto-advance modal can fire off a real predicate (outcome =
-- 'accepted' AND root_cause non-empty) instead of page-view telemetry.
--
-- Side-paths off the same card:
--   - 'rejected'        → case short-circuits to Completed (not-our-issue)
--   - 'needs_more_info' → case stays in Under Verification, customer
--                         follow-up logged via assr_service_log
--
-- All four columns nullable: existing cases pre-082 stay untouched
-- until QA revisits them.

ALTER TABLE assr_cases ADD COLUMN verification_outcome  TEXT
  CHECK (verification_outcome IN ('accepted','rejected','needs_more_info'));
ALTER TABLE assr_cases ADD COLUMN verified_root_cause   TEXT;
ALTER TABLE assr_cases ADD COLUMN verified_by           INTEGER REFERENCES users(id);
ALTER TABLE assr_cases ADD COLUMN verified_at           TEXT;

CREATE INDEX idx_assr_cases_verification_outcome
  ON assr_cases(verification_outcome)
  WHERE verification_outcome IS NOT NULL;

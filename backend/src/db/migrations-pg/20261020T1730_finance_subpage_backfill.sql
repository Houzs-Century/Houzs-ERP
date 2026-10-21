-- 20261020T1730_finance_subpage_backfill.sql
-- REVERSAL: DELETE FROM public.role_page_access
--   WHERE page_key IN ('scm.finance.money_in','scm.finance.money_out',
--     'scm.finance.bank','scm.finance.books','scm.finance.reports',
--     'scm.finance.forecast','scm.finance.setup');
--   Revert the code (services/pageAccess.ts) first so these keys leave the
--   catalogue; the rows then become inert (resolvePositionAccessFromRows filters
--   by isValidPageKey) and the DELETE merely tidies them. No grants to re-apply.
--
-- WHAT THIS CHANGES, and why it is a byte-for-byte no-op for every login today.
-- services/pageAccess.ts splits the Finance area into seven per-group page keys
-- (scm.finance.money_in / .money_out / .bank / .books / .reports / .forecast /
-- .setup), each a CHILD of scm.finance.accounting. At login they inherit their
-- parent's resolved level, so no member's access changes on deploy
-- (financeSubpageSplit.test.ts pins this). This migration writes the SAME value
-- as an explicit row per role, copied from that role's existing
-- scm.finance.accounting row.
--
-- WHY THE EXPLICIT ROWS ARE NEEDED (not just the cascade). PR1 seeded every role
-- a COMPLETE row set (one row per catalogue key; prod 2026-10-20 = 24 roles x 50
-- rows). The role matrix (PR2) and the Excel import (PR3) both PATCH a role's
-- ENTIRE page-access set (replace-set): any catalogue key missing a staged row is
-- re-persisted as `none`. A new key with no stored row would therefore be written
-- `none` the next time the owner saves ANY role — silently hiding the finance
-- pages he did not touch. Backfilling the row keeps the invariant "every role has
-- a row for every key", so the matrix loads each new key at its real (inherited)
-- level and a save round-trips it unchanged.
--
-- WHY COPY FROM scm.finance.accounting, not recompute. The owner is actively
-- re-configuring roles; recomputing from the position policy would clobber his
-- hand edits. Copying the role's CURRENT accounting level preserves exactly what
-- each role holds today: the 4 full-finance roles -> full, the 7 see-only roles
-- (Logistic/BD/Ops/Purchaser/IT Admin/HR/Logistic Admin) -> view (money-write
-- stays denied), the 13 none-roles -> none. ON CONFLICT DO NOTHING makes a re-run
-- idempotent and never overwrites a value the owner later sets explicitly.
-- RE-RUN: safe (idempotent) — only inserts a (role, new-key) pair that is absent.

INSERT INTO public.role_page_access (role_id, page_key, level, created_at, updated_at)
SELECT a.role_id, k.page_key, a.level,
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
FROM public.role_page_access a
CROSS JOIN (VALUES
  ('scm.finance.money_in'),
  ('scm.finance.money_out'),
  ('scm.finance.bank'),
  ('scm.finance.books'),
  ('scm.finance.reports'),
  ('scm.finance.forecast'),
  ('scm.finance.setup')
) AS k(page_key)
WHERE a.page_key = 'scm.finance.accounting'
ON CONFLICT (role_id, page_key) DO NOTHING;

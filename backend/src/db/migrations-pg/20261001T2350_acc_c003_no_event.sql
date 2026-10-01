-- 20261001T2350_acc_c003_no_event.sql
-- REVERSAL:
--   UPDATE scm.accounts SET needs_event = true WHERE account_code = '900-C003';
--   GRANTS: none — rows of an existing table.
-- Verified against: staging (minnapsemfzjmtvnnvdd) via MCP apply_migration on
--   2026-10-01; the rows read back in the PR body.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one column
-- (needs_event — 20261001T2100) on one account code, in every company carrying
-- it, exactly as the Chart page's own update writes a code. Its PMS row
-- (Commission) stays. No journal entry, amount or other column moves.
--
-- WHY (owner 2026-10-01: C003 取消需要 Event → 做). Commission is worked out in
-- HR per salesperson from their own SOs and paid out per person per month — one
-- payment spans many events, so a commission voucher on 900-C003 COMMISSION
-- ( EVENT ) cannot name one Event, and approval must not ask for it. An event's
-- commission comes from its SOs, not from the payout voucher.

SET search_path = public, scm;

UPDATE scm.accounts SET needs_event = false
 WHERE account_code = '900-C003' AND needs_event;

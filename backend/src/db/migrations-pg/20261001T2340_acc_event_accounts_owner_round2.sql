-- 20261001T2340_acc_event_accounts_owner_round2.sql
-- REVERSAL:
--   UPDATE scm.accounts SET needs_event = true WHERE account_code IN ('900-B005', '900-E011');
--   UPDATE scm.accounts SET pms_row = 'transport_fee' WHERE account_code IN ('900-T031', '900-T032', '900-T033');
--   GRANTS: none — rows of an existing table.
-- Verified against: staging (minnapsemfzjmtvnnvdd) via MCP apply_migration on
--   2026-10-01; the rows read back in the PR body.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: two columns
-- (needs_event, pms_row — 20261001T2100) on five account codes, in every company
-- carrying them, exactly as the Chart page's own update writes a code. No journal
-- entry, amount or other column moves.
--
-- WHY (owner 2026-10-01, reviewing the thirteen 需要 Event accounts):
--   · 900-b005 不需要 — BOOTH SET UP - NEW DESIGN no longer needs its Event at
--     approval. Its PMS row (Setup) stays: a line that does name an event still
--     fills that event's Setup.
--   · "900-e001 不需要" — 是 E011: EXHIBITION/ROADSHOW EXP - DECORATION no longer
--     needs its Event either; its row (Setup) stays the same way.
--   · 900-T031, T032, T033 都是同一个 Transport Setup & Dismantle — the three
--     TRANSPORT FAIR accounts fill Transport Setup & Dismantle, not Transport Fee
--     (which stays the rate card's % of sales unless the books fill it).
-- 900-E002 (不需要先) was already unticked on the Chart page by the owner; this
-- file does not touch it. 900-C003 waits on his answer (commission is worked out
-- monthly, not per event).

SET search_path = public, scm;

UPDATE scm.accounts SET needs_event = false
 WHERE account_code IN ('900-B005', '900-E011') AND needs_event;

UPDATE scm.accounts SET pms_row = 'transport_setup_dismantle'
 WHERE account_code IN ('900-T031', '900-T032', '900-T033')
   AND pms_row IS DISTINCT FROM 'transport_setup_dismantle';

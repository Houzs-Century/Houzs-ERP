-- 20261001T2300_acc_debtor_bill_line_event.sql
-- REVERSAL: ALTER TABLE scm.acc_debtor_bill_lines DROP COLUMN IF EXISTS project_id;
--   Revert the code first: routes/other-debtors.ts and routes/ar-invoices.ts write
--   and read the column, and the AR Invoices page's Other Debtor bill form sends
--   it, once the PR that ships this file is live. Dropping it loses only the event
--   named on bill lines; the journal legs keep their own copy
--   (journal_entry_lines.project_id). GRANTS: none — a column on an existing table
--   rides that table's grants.
-- Verified against: staging (minnapsemfzjmtvnnvdd) via MCP apply_migration on
--   2026-10-01; the column read back in the PR body.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one nullable
-- bigint on scm.acc_debtor_bill_lines. NULL — every existing row's value — means
-- "no event", which is what every line means today. No default, no rewrite of
-- existing rows, no constraint an existing row could fail, and no foreign key to
-- public.projects, by the precedent 20260930T0400 records: a PMS delete must
-- never fail on, or cascade into, accounting rows; the route checks an id
-- against the active company's events before it writes it.
--
-- WHY (owner 2026-10-01, payment-request item 6: other debtor 单也要，但不是一定要选).
-- An Other Debtor bill line may name the event it is for — optional, never asked
-- for. Posting carries it onto the line's own credit leg, so a rental billed back
-- to an organiser (Cr 900-R032) lowers that event's Rental on the PMS event page
-- and on the Event costs report, both of which read the ledger. The code that
-- writes the column ships in the same PR and runs only after this file
-- (pg-migrate runs before the Worker deploy).

SET search_path = public, scm;

ALTER TABLE scm.acc_debtor_bill_lines ADD COLUMN IF NOT EXISTS project_id bigint;

-- 20260930T0400_acc_event_per_line.sql
-- REVERSAL: DROP INDEX IF EXISTS scm.idx_jel_project;
--   ALTER TABLE scm.journal_entry_lines DROP COLUMN IF EXISTS project_id;
--   ALTER TABLE scm.ap_invoice_lines DROP COLUMN IF EXISTS project_id;
--   ALTER TABLE scm.payment_voucher_lines DROP COLUMN IF EXISTS project_id;
--   Revert the code first: postJournal, reverseJournal and the PV / AP invoice routes write
--   and read these columns once the PR that ships this file is live. Dropping them loses
--   only the event tags; no amount, account or date lives in them. GRANTS: none to re-apply.
-- Verified against: staging (minnapsemfzjmtvnnvdd) via MCP apply_migration on 2026-09-30;
--   the three columns and the index read back in the PR body.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- 1. scm.payment_voucher_lines, scm.ap_invoice_lines and scm.journal_entry_lines each gain a
--    nullable project_id: the event (a public.projects row) the line's money is for. NULL is
--    every existing row's value and means "no event", which is what every line means today.
--    No default, no rewrite of existing rows, no constraint that an existing row could fail.
-- 2. No foreign key to public.projects, on purpose and by precedent: scm.mfg_sales_orders.
--    project_id carries none either (0146) — a cross-schema FK would let a PMS delete of a
--    project fail on accounting rows, or cascade into the ledger. The routes check an id
--    against the active company's projects before they write it.
-- 3. A partial index on journal_entry_lines for the event cost report, which reads only the
--    tagged lines of one company.
--
-- WHY (owner 2026-09-29/30: 我的 payment 可能需要绑定 event — 5a, event per line, the header
-- a default). A voucher or AP invoice line names its event; posting carries it onto that
-- line's journal leg, and a reversal carries it onto the contra, so an event's cost is read
-- from the ledger itself (docs/新ERP会计模块需求书.md: a dimension goes on each journal line,
-- never a parallel ledger). The code that writes the columns ships in the same PR and runs
-- only after this file (pg-migrate runs before the Worker deploy).

SET search_path = public, scm;

ALTER TABLE scm.payment_voucher_lines ADD COLUMN IF NOT EXISTS project_id bigint;
ALTER TABLE scm.ap_invoice_lines ADD COLUMN IF NOT EXISTS project_id bigint;
ALTER TABLE scm.journal_entry_lines ADD COLUMN IF NOT EXISTS project_id bigint;

CREATE INDEX IF NOT EXISTS idx_jel_project ON scm.journal_entry_lines (company_id, project_id) WHERE project_id IS NOT NULL;

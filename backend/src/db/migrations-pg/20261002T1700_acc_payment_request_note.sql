-- 20261002T1700_acc_payment_request_note.sql
-- REVERSAL: ALTER TABLE scm.acc_payment_requests DROP COLUMN IF EXISTS note;
--   Revert the code first: routes/payment-requests.ts selects and writes note
--   (COLS, readFields); the request forms send it; the voucher and AP invoice
--   forms read it into their Notes. Dropping the column loses every note typed.
--   GRANTS: none to re-apply — a column rides its table's grants.
-- Verified against: staging (minnapsemfzjmtvnnvdd) via MCP apply_migration on
--   2026-10-02; the column read back from information_schema in the PR body.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- nullable text column on scm.acc_payment_requests; no row written, nothing
-- else altered. Applied by the Deploy run before the Worker that selects it.
--
-- WHY (owner 2026-10-02: 我希望多一个第五给他们写note — then 做 on the
-- proposal): the requester's own note to Finance, the fifth step of the request
-- form. Finance sees it on the request, and it comes along into the voucher's or
-- the AP invoice's Notes when Finance answers. Finance's own note when it
-- returns a request stays finance_note.

ALTER TABLE scm.acc_payment_requests ADD COLUMN IF NOT EXISTS note text;

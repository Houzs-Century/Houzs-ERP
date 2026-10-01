-- 20261001T2100_acc_account_event_pms.sql
-- REVERSAL: ALTER TABLE scm.accounts DROP COLUMN IF EXISTS needs_event,
--             DROP COLUMN IF EXISTS pms_row;
--   Revert the code first: routes/accounting-chart.ts (the chart's two new
--   columns), lib/event-accounts.ts (the approval check) and the PMS event page's
--   Finance rows read these columns. Dropping them lifts the "needs its Event"
--   check at approval and sends no Finance money to the PMS event page; no
--   journal entry depends on them.
--   GRANTS: none — columns on an existing table ride that table's grants.
-- Verified against: staging (minnapsemfzjmtvnnvdd) via MCP apply_migration on
--   2026-10-01; the columns and the defaulted rows read back in the PR body.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: two new
-- columns on scm.accounts (a boolean defaulting to false, a nullable text with a
-- CHECK) and the owner's defaults written onto the thirteen account codes his
-- table names — only these two new columns on those rows, nothing else.
--
-- WHY (owner 2026-10-01, payment-request item 4 → 做: 申请人不用选类型，我定好
-- 哪里一些类型需要就一定要选event — the requester never picks a type; FINANCE
-- decides it, on the chart, per account):
--   • needs_event — a voucher or AP invoice line on this account cannot be
--     approved without its Event (in a company that runs events);
--   • pms_row     — which row of the PMS event page the money fills (item 5):
--     rental / setup / transport_setup_dismantle / transport_fee / commission /
--     others; an account with none fills Others Costing when it carries an Event.
-- The defaults are the table the owner agreed (2026-10-01); a definition field,
-- so every company carrying the code takes the same values (the chart is one
-- definition per code); a company without events is never asked.

SET search_path = public, scm;

ALTER TABLE scm.accounts
  ADD COLUMN IF NOT EXISTS needs_event boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pms_row text CHECK (pms_row IS NULL OR pms_row IN ('rental', 'setup', 'transport_setup_dismantle', 'transport_fee', 'commission', 'others'));

UPDATE scm.accounts SET needs_event = true, pms_row = 'rental'
  WHERE account_code IN ('900-R031', '900-R032', '360-0010');
UPDATE scm.accounts SET needs_event = true, pms_row = 'setup'
  WHERE account_code IN ('900-B003', '900-B005', '900-E011');
UPDATE scm.accounts SET needs_event = true, pms_row = 'transport_setup_dismantle'
  WHERE account_code IN ('900-T030', '900-T035');
UPDATE scm.accounts SET needs_event = true, pms_row = 'transport_fee'
  WHERE account_code IN ('900-T031', '900-T032', '900-T033');
UPDATE scm.accounts SET needs_event = true, pms_row = 'commission'
  WHERE account_code = '900-C003';
UPDATE scm.accounts SET needs_event = true, pms_row = 'others'
  WHERE account_code = '900-E002';

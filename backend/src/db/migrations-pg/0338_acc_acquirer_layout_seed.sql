-- REVERSAL:
--   UPDATE scm.acc_acquirer_config
--      SET statement_format = NULL, has_unique_ref = NULL, fee_method = NULL,
--          column_map = NULL, total_net_label = NULL, summary_totals = NULL,
--          dates_have_no_year = FALSE
--    WHERE code IN ('HLB','MBB','GHL','PBB','AEON');
--   (Returns those rows to 0332's freshly-unified state — "not taught yet".
--   Rows this migration did NOT touch — already taught before it ran — are
--   skipped by its own WHERE, so the blanket reversal above is wider than the
--   forward step; narrow it by hand if any acquirer was hand-taught first.)
--
-- acc_acquirer_layout_seed — the five statement layouts arrive TAUGHT.
--
-- 0332 built the global config and left every layout column NULL, so the
-- setup screen greeted the owner with five "not taught yet" rows for formats
-- this repository already KNOWS: each layout below was read from the owner's
-- real files, exercised by the committed fixtures in demo-statements/, and
-- passed by him on the rig (merchant side 2026-08-20, MBB/PBB 2026-08-24).
-- A fact the repo has verified is data, not homework — the owner's word:
-- 为什么report setup 我还需要自己set (2026-08-27).
--
-- What stays his: scm.acc_company_acquirers — which company uses which
-- acquirer and into which bank/transit/fee accounts the money lands. This
-- migration does not touch that table.
--
-- Idempotent and NON-CLOBBERING: every row is inserted on absence, and
-- updated ONLY while still untaught (statement_format IS NULL) — a layout
-- taught or corrected through the UI is never overwritten, so re-running
-- this file is always safe.
--
-- Sources of record: backend/scripts/settlement-demo-server.ts (the rig's
-- validated config) and docs/acquirer-statement-formats.md. GHL's
-- has_unique_ref is FALSE by the owner's 2026-08-17 ruling: the till does
-- not capture the gateway id, so nothing shared exists to match on. AEON's
-- tolerance is 7: instalment settlements drift a week.

INSERT INTO scm.acc_acquirer_config
  (code, display_name, statement_format, has_unique_ref, fee_method,
   date_tolerance_days, column_map, total_net_label, summary_totals,
   dates_have_no_year, is_active)
VALUES
  ('HLB', 'HLB', 'CSV', TRUE, 'stated', 3,
   '{"date":"DATE","ref":"INVOICE/AUTHO","gross":"TRXN AMOUNT","fee":"MDR","net":"TRXN NET"}'::jsonb,
   NULL, NULL, TRUE, TRUE),
  ('MBB', 'MBB', 'CSV', TRUE, 'prorated-summary', 3,
   '{"date":"Tran Date","ref":"Auth Code","gross":"Amount"}'::jsonb,
   NULL, '{"rowLabel":"TOTAL","fee":"Disc. Amt","net":"Net Amount"}'::jsonb,
   FALSE, TRUE),
  ('GHL', 'GHL', 'CSV', FALSE, 'stated', 3,
   '{"date":"tx_create_date","ref":"gateway_tx_id","gross":"tx_amount","fee":"merchant_mdr_amount","net":"net_amount"}'::jsonb,
   NULL, NULL, FALSE, TRUE),
  ('PBB', 'PBB', 'CSV', TRUE, 'gross-minus-net', 3,
   '{"date":"Trans_date","ref":"Approval_code","gross":"Trans_amt","net":"Sett_amt"}'::jsonb,
   NULL, NULL, FALSE, TRUE),
  ('AEON', 'AEON', 'CSV', TRUE, 'stated', 7,
   '{"date":"DATE","ref":"APP. CODE","gross":"GROSS AMOUNT (RM)","fee":"MDR AMOUNT (RM)","net":"NET AMOUNT (RM)"}'::jsonb,
   'TOTAL NET PAYMENT (RM) :', NULL, FALSE, TRUE)
ON CONFLICT (code) DO UPDATE SET
  statement_format    = EXCLUDED.statement_format,
  has_unique_ref      = EXCLUDED.has_unique_ref,
  fee_method          = EXCLUDED.fee_method,
  date_tolerance_days = EXCLUDED.date_tolerance_days,
  column_map          = EXCLUDED.column_map,
  total_net_label     = EXCLUDED.total_net_label,
  summary_totals      = EXCLUDED.summary_totals,
  dates_have_no_year  = EXCLUDED.dates_have_no_year,
  updated_at          = now()
WHERE scm.acc_acquirer_config.statement_format IS NULL;

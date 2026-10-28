-- 0037_scm_payment_three_methods.sql
-- Payment-method model: 4 -> 3 top-level methods (Merchant / Online / Cash).
--
-- 'Installment' is no longer a top-level payment_method — it is the *plan under
-- Merchant* (a bank EPP receipt is recorded as Method = Merchant + an
-- installment_months tenure). The code-side protected set was reduced 4 -> 3
-- (scm/shared/payment-methods.ts), so this migration's deactivation of the L1
-- 'Installment' row is no longer re-locked / re-added by isCorePaymentMethodRow.
--
-- (a) Deactivate the L1 'Installment' payment_method row (idempotent — the
--     installment_plan L2 tenures and any stored ledger rows with method
--     'installment' are untouched; this only drops the L1 method choice).
-- (b) Seed the full intended payment_merchant bank set idempotently — the
--     field's own hint lists 9+ banks and AEON terminals appear on real
--     receipts. Adds RHB / Bank Islam / BSN / AmBank / AEON / HSBC while
--     keeping any already-present rows (MBB / CIMB / Public / HLB / Alliance /
--     Pinelabs). ON CONFLICT (category, value) DO NOTHING makes re-paste safe
--     regardless of which banks the live DB already has.
--
-- Zero data migration: scm.mfg_sales_order_payments currently has 0 rows, so no
-- payment row references the L1 'Installment' method.
--
-- ADDITIVE + idempotent. Outer BEGIN;/COMMIT; omitted — pg-migrate.mjs wraps the
-- whole file in one transaction. SET search_path = scm so the unqualified
-- so_dropdown_options resolves to scm.* (pg-migrate's default search_path
-- excludes scm).

SET search_path = scm, public;

-- (a) Drop 'Installment' as a top-level method (deactivate, idempotent).
UPDATE scm.so_dropdown_options
   SET active = false
 WHERE category = 'payment_method'
   AND value = 'Installment'
   AND active = true;

-- (b) Seed the full intended merchant-bank set (idempotent).
INSERT INTO scm.so_dropdown_options (category, value, label, sort_order) VALUES
  ('payment_merchant', 'MBB',        'MBB',        1),
  ('payment_merchant', 'CIMB',       'CIMB',       2),
  ('payment_merchant', 'Public',     'Public',     3),
  ('payment_merchant', 'HLB',        'HLB',        4),
  ('payment_merchant', 'Alliance',   'Alliance',   5),
  ('payment_merchant', 'Pinelabs',   'Pinelabs',   6),
  ('payment_merchant', 'RHB',        'RHB',        7),
  ('payment_merchant', 'Bank Islam', 'Bank Islam', 8),
  ('payment_merchant', 'BSN',        'BSN',        9),
  ('payment_merchant', 'AmBank',     'AmBank',     10),
  ('payment_merchant', 'AEON',       'AEON',       11),
  ('payment_merchant', 'HSBC',       'HSBC',       12)
ON CONFLICT (category, value) DO NOTHING;

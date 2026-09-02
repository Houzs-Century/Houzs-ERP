-- REVERSAL:
--   DROP TABLE scm.acc_vendor_memory;
--   (Additive only — nothing else references the table. It is a cache of
--   operator habit, not a book of record: every value in it was copied FROM
--   a saved Payment Voucher and can be relearned by saving one more. Losing
--   it costs one manual account pick per vendor, never a figure.)
--
-- acc_vendor_memory — 我想要你要有记忆我下次submit 同个类型的invoice自动帮我填，
-- 选account 等等 (the owner, 2026-09-02).
--
-- One row per (company, vendor) remembering what the operator ACTUALLY saved
-- the last time they paid this vendor: the payee's proper casing, the expense
-- account they picked, the purpose. NOT what the model guessed — the OCR
-- reads the paper, this table remembers the human's answer, and the next
-- scan of the same vendor pre-fills from it (still checked and saved by a
-- person through the untouched approval cycle).
--
-- vendor_key is normalizeVendor() output (bill-extract.ts): uppercase, the
-- SDN BHD / S/B / ENTERPRISE tails stripped — the same key the supplier
-- matcher uses, so "TNB", "Tenaga Nasional Bhd" and the OCR's reading of
-- either all land on one row. last-saved-wins; times_seen only grows.

CREATE TABLE IF NOT EXISTS scm.acc_vendor_memory (
  company_id  BIGINT      NOT NULL,
  vendor_key  TEXT        NOT NULL,
  payee_name  TEXT,
  debit_account_code TEXT,
  purpose     TEXT,
  times_seen  INTEGER     NOT NULL DEFAULT 1 CHECK (times_seen >= 1),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, vendor_key)
);

COMMENT ON TABLE scm.acc_vendor_memory IS
  'Per-company vendor habit: what the operator saved last time (payee casing, expense account, purpose). Learned on PV save, read by POST /payment-vouchers/extract to pre-fill the next same-vendor bill.';

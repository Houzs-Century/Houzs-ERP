-- REVERSAL:
--   ALTER TABLE scm.pv_allocations DROP COLUMN from_advance;
--   DROP TABLE scm.acc_supplier_advances;
--   (Additive only — no existing row is touched going forward, so dropping
--   what this created restores 0339's shape exactly. Any advances recorded
--   in between are knock-off BOOKKEEPING, not GL: their journal never
--   existed, so there is no entry to unwind — but the PIs they settled keep
--   their paid_sen, which the drop orphans; un-apply them first if any
--   applied_sen > 0.)
--
-- acc_supplier_advances — 预付挂在 supplier (the owner, 2026-08-30: 预付就不能
-- 直接挂在supplier 那边吗?).
--
-- An AP Payment may pay MORE than the invoices it ticks. The excess is not a
-- separate expense and gets no separate account: the voucher's one GL line
-- already debited the AP control for the WHOLE amount, so the supplier's AP
-- subledger simply runs ahead — money paid, invoice to come. This table is
-- the ledger of that running-ahead: one row per posted voucher that paid
-- ahead, how much, and how much of it has since been knocked off against
-- real invoices.
--
-- Applying an advance to a later invoice is NOT a payment and posts NOTHING:
-- both legs already live in AP (the debit from the old voucher, the credit
-- from the invoice posting). It only settles the invoice's paid_sen and
-- burns applied_sen here — AutoCount's unapplied-payment knock-off, by its
-- Houzs name.
--
-- amount_sen is written ONCE at post time and never edited; applied_sen only
-- grows, and never past amount_sen (the CHECK). One row per voucher (the
-- UNIQUE): a voucher pays ahead once, however many times the advance is
-- later applied.

CREATE TABLE IF NOT EXISTS scm.acc_supplier_advances (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   INTEGER NOT NULL,
  supplier_id  TEXT    NOT NULL,
  pv_id        TEXT    NOT NULL,
  pv_number    TEXT    NOT NULL,
  amount_sen   BIGINT  NOT NULL CHECK (amount_sen > 0),
  applied_sen  BIGINT  NOT NULL DEFAULT 0 CHECK (applied_sen >= 0 AND applied_sen <= amount_sen),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_supplier_advance_once UNIQUE (pv_id)
);

CREATE INDEX IF NOT EXISTS acc_supplier_advances_supplier
  ON scm.acc_supplier_advances (company_id, supplier_id);

-- Applications ride the existing pv_allocations rows (same shape, same
-- clamped settle path); this flag says which rows moved MONEY (false — the
-- voucher's own bank payment) and which only moved BOOKKEEPING (true — a
-- later knock-off funded by the advance).
ALTER TABLE scm.pv_allocations ADD COLUMN IF NOT EXISTS from_advance BOOLEAN NOT NULL DEFAULT FALSE;

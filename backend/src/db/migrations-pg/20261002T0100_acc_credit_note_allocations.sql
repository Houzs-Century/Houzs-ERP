-- 20261002T0100_acc_credit_note_allocations.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.acc_credit_note_allocations;
--   Revert the code first: routes/credit-notes.ts (apply / remove / the apply at
--   post) and acc/credit-note-allocations.ts write and read this table. Each row
--   moved its invoice's paid_sen by applied_sen through the settle functions; to
--   drop the table with rows in it, first take every applied_sen back off its
--   invoice (scm.settle_pi_paid_sen / scm.settle_api_paid_sen with the negative),
--   or the invoices keep the credit with no record of where it came from.
--   GRANTS: none to re-apply — it rides the scm schema's default privileges
--   (service_role), like scm.pv_allocations.
-- Verified against: staging (minnapsemfzjmtvnnvdd) via MCP apply_migration on
--   2026-10-02; the table, its checks, FKs and indexes read back in the PR body.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- empty table and three indexes; no row written, nothing altered.
--
-- WHY (owner 2026-10-01, Supplier CN part 2: 有写发票的 CN 直接扣那张发票的欠款；
-- 没写的先挂在 Diglant 名下，再选要扣哪几张发票；付款时只付剩下的). A posted supplier
-- credit note's credit comes off a supplier invoice the way a payment voucher's
-- money does (scm.pv_allocations): one row per invoice credited, amount_sen asked
-- and applied_sen what the settle actually moved (the clamp may take less), so a
-- cancel or a remove gives back exactly what was applied. The ledger is not
-- touched here — the note's own journal (Dr AP control / Cr the lines) already
-- carries the money; this is the invoice's side of it.

CREATE TABLE IF NOT EXISTS scm.acc_credit_note_allocations (
  id                   uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id           bigint      NOT NULL,
  note_id              uuid        NOT NULL REFERENCES scm.acc_credit_notes(id) ON DELETE CASCADE,
  purchase_invoice_id  uuid        REFERENCES scm.purchase_invoices(id) ON DELETE RESTRICT,
  ap_invoice_id        uuid        REFERENCES scm.ap_invoices(id) ON DELETE RESTRICT,
  amount_sen           bigint      NOT NULL CHECK (amount_sen > 0),
  applied_sen          bigint      NOT NULL DEFAULT 0 CHECK (applied_sen >= 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           text,
  CONSTRAINT acc_credit_note_allocations_one_target CHECK ((purchase_invoice_id IS NULL) <> (ap_invoice_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_acc_cn_alloc_note ON scm.acc_credit_note_allocations (note_id);
CREATE INDEX IF NOT EXISTS idx_acc_cn_alloc_pi ON scm.acc_credit_note_allocations (purchase_invoice_id) WHERE purchase_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acc_cn_alloc_api ON scm.acc_credit_note_allocations (ap_invoice_id) WHERE ap_invoice_id IS NOT NULL;

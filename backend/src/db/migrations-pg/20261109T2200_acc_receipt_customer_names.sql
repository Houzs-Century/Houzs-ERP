-- 20261109T2200_acc_receipt_customer_names.sql
-- Official receipts carry their customer's name, and the receipts the Bank recon
-- catch-up confirmed name their confirmer (owner 2026-11-09, printing one: "Confirmed:
-- Claude, for the owner (2026-11-09) — matched in …" 是什么东西 / 为甚没有name 这些 →
-- 做, Confirmed 写 Chew).
--
-- 1. No payment writer ever passed the customer, so every receipt was born without a
--    name (production 2026-11-09: 1,939 receipts, every status, both companies) and
--    printed "Name: —". acc/receipts.ts now reads it when a receipt is born; this fills
--    the ones already on file: a sales-order payment's from its order (debtor_name — the
--    column the order keeps its customer in, docs/bugs/0655), a sales-invoice payment's
--    from its invoice. Only where the receipt has no name; an order with none gives none.
-- 2. scripts/confirm-banked-receipts.mjs (2026-11-09, 298 receipts: 2990 44, Houzs 254)
--    stamped "Claude, for the owner (2026-11-09) — matched in Bank recon" as who
--    confirmed the money, and the receipt prints it. The owner named the confirmer:
--    Chew.
--
-- Data only; idempotent (each UPDATE touches only rows still to fix). No trigger guards
-- acc_official_receipts; the receipt's number, status and money are not touched.
-- RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL: the names cannot be told from ones typed later; to undo step 2 set
--   issued_by back for the receipts whose issued_by = 'Chew' and issued_at falls on
--   2026-11-09 09:3x–09:5x UTC (the two catch-up runs, 42595128861 and 42595501431).

UPDATE scm.acc_official_receipts r
   SET customer_name = btrim(o.debtor_name)
  FROM scm.mfg_sales_orders o
 WHERE r.payment_source = 'SOPAY'
   AND o.company_id = r.company_id
   AND o.doc_no = r.doc_no
   AND COALESCE(btrim(r.customer_name), '') = ''
   AND COALESCE(btrim(o.debtor_name), '') <> '';

UPDATE scm.acc_official_receipts r
   SET customer_name = btrim(si.debtor_name)
  FROM scm.sales_invoices si
 WHERE r.payment_source = 'SIPAY'
   AND si.company_id = r.company_id
   AND si.id::text = r.doc_no
   AND COALESCE(btrim(r.customer_name), '') = ''
   AND COALESCE(btrim(si.debtor_name), '') <> '';

UPDATE scm.acc_official_receipts
   SET issued_by = 'Chew'
 WHERE issued_by = 'Claude, for the owner (2026-11-09) — matched in Bank recon';

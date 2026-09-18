-- 20260907T1026_ac_header_notcarried_columns.sql
--
-- The four AutoCount header fields the ERP had NOWHERE TO PUT.
--
-- WHY. check-ac-erp-reconcile.mjs's field-identity section (PR #3061) classifies
-- a field NOT_CARRIED when the book holds a column and no importer names an ERP
-- column for it. Four such fields were measured on go-live day, 2026-09-07, and
-- the owner ruled "四个都加" - add all four. This migration gives each of them a
-- home; nothing here writes a value. The values arrive through
-- sync-ac-delta.mjs LANES=hdr, which reads lib/ac-header-fields.mjs.
--
-- WHAT EACH COLUMN IS, measured against ac-doc-headers.json.gz cut
-- 2026-09-07T17:36+08:00 from the live AED_HOUZS book (13,365 SO / 9,408 PO
-- headers, test documents excluded):
--
--   delivery_address1..4   SO.DeliverAddr1..4. Filled on 12,791 / 10,384 /
--     11,991 / 10,027 sales orders. THE OPERATIONAL ONE: the goods go where the
--     invoice is not always addressed. Measured, the two addresses are IDENTICAL
--     on 12,667 orders and genuinely DIFFERENT on 112, with a further 12 that
--     carry a delivery address and no invoice address - so 124 documents in the
--     whole book would send a driver to the wrong place if the ERP kept only
--     address1..4. That is the number this column is for; it is not 12,791.
--
--     FOUR COLUMNS, NOT ONE. scm.mfg_sales_orders already has `ship_to_address`,
--     a single text column. Folding AutoCount's four lines into it would be a
--     join we invented - computing, not copying (memory:
--     migration-copy-never-compute) - and it could not be compared back against
--     the book field by field. These mirror address1..4 exactly, which is what
--     lets the reconciler read them as one shape.
--
--   display_term           SO.DisplayTerm / PO.DisplayTerm - the credit term
--     AutoCount PRINTS on the document. Filled on every one of the 13,365 sales
--     orders and every one of the 9,408 purchase orders, and it holds exactly
--     ONE distinct value book-wide: 'C.O.D.'. Recorded because the ERP keeps
--     terms on the CUSTOMER, not on the order, so a document whose printed term
--     ever stops being C.O.D. is invisible to us today. `display_term` is the
--     spelling this repo already uses for it (migrations/033_creditors.sql:46).
--
--   attention              SO.Attention / PO.Attention - the contact person
--     AutoCount addresses the document to. Filled on 3,018 sales orders and 300
--     purchase orders.
--
--   ac_to_po_no            SO.UDF_ToPONo, verbatim, comma-joined by AutoCount.
--
--     THE NAME IS DELIBERATE AND IT IS NOT `customer_po_no`. This field reached
--     this change described as "customer PO number". It is not: of the 7,071
--     sales orders carrying a value, 7,068 hold a string beginning "PO-"
--     (samples: SO-000002 -> "PO-000972", SO-013507 -> "PO-010170"), i.e. the
--     PURCHASE ORDERS AUTOCOUNT RAISED FROM THE ORDER, going out to a supplier -
--     the opposite direction from a customer's own PO. Naming the column
--     `customer_po_no` would bake the wrong meaning into the schema, and this
--     repo has already dropped four dead `customer_po*` columns once
--     (0312, census run 32280818981). The ERP expresses this relationship
--     properly as an SO->PO line link; this column is the book's own text, kept
--     so the two can be compared.
--
-- WHY THE ERP SIDE IS ADDITIVE ONLY. Every column is nullable with no default
-- and no backfill. An ADD COLUMN of a nullable column with no default is a
-- catalog-only change in Postgres: no table rewrite and no row touched. Nothing
-- in the application reads these columns yet, so shipping this changes no screen
-- and no total.
--
-- WHY NO VIEW WORK. scm.mfg_sales_orders_with_payment_totals projects columns by
-- name; ADDING a column is invisible to it (the 0189 -> 0190 -> 0191 grant
-- incident was a DROP, which forces a view recreate). Nothing is dropped here.
--
-- WHY THE PO GETS ONLY TWO OF THEM. AutoCount's PO.DeliverAddr1..4 is OUR OWN
-- receiving address, not a customer's, and it is the same on all 9,408 purchase
-- orders; the owner's ruling was about the address goods are DELIVERED TO on a
-- sales order. Adding it to the PO would be four columns of one repeated value.
-- If that is wanted later it is another ADD COLUMN, not a rework.
--
-- Reversal: ALTER TABLE scm.mfg_sales_orders DROP COLUMN IF EXISTS attention,
--   DROP COLUMN IF EXISTS delivery_address1, DROP COLUMN IF EXISTS delivery_address2,
--   DROP COLUMN IF EXISTS delivery_address3, DROP COLUMN IF EXISTS delivery_address4,
--   DROP COLUMN IF EXISTS display_term, DROP COLUMN IF EXISTS ac_to_po_no;
--   ALTER TABLE scm.purchase_orders DROP COLUMN IF EXISTS attention,
--   DROP COLUMN IF EXISTS display_term;
--   Safe to reverse for as long as nothing has been written into them: the
--   columns land EMPTY and stay empty until sync-ac-delta LANES=hdr is
--   dispatched. After that lane has run, a reversal DISCARDS the copied values,
--   and they come back by re-running the lane, not by undoing the DROP.
-- Verified against: the live AED_HOUZS book through
--   backend/scripts/data/ac-doc-headers.json.gz (exported 2026-09-07T17:36:03+08:00,
--   13,365 SO + 9,408 PO headers) for every fill count quoted above, and against
--   scm.mfg_sales_orders / scm.purchase_orders as they stand on main - neither
--   table carries any of these names today (checked across every file in
--   backend/src/db/migrations-pg/ and backend/scripts/scm-schema/2990s-full-schema.sql).
--   `IF NOT EXISTS` on every statement makes the migration idempotent regardless.

ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS attention         text;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS delivery_address1 text;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS delivery_address2 text;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS delivery_address3 text;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS delivery_address4 text;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS display_term      text;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS ac_to_po_no       text;

ALTER TABLE scm.purchase_orders  ADD COLUMN IF NOT EXISTS attention         text;
ALTER TABLE scm.purchase_orders  ADD COLUMN IF NOT EXISTS display_term      text;

COMMENT ON COLUMN scm.mfg_sales_orders.delivery_address1 IS 'AutoCount SO.DeliverAddr1, verbatim. The address the GOODS go to, which is not always address1..4 (the invoice address). Written by sync-ac-delta.mjs LANES=hdr.';
COMMENT ON COLUMN scm.mfg_sales_orders.delivery_address2 IS 'AutoCount SO.DeliverAddr2, verbatim.';
COMMENT ON COLUMN scm.mfg_sales_orders.delivery_address3 IS 'AutoCount SO.DeliverAddr3, verbatim.';
COMMENT ON COLUMN scm.mfg_sales_orders.delivery_address4 IS 'AutoCount SO.DeliverAddr4, verbatim.';
COMMENT ON COLUMN scm.mfg_sales_orders.display_term      IS 'AutoCount SO.DisplayTerm, verbatim - the credit term the book PRINTS. The ERP own terms live on the customer.';
COMMENT ON COLUMN scm.mfg_sales_orders.attention         IS 'AutoCount SO.Attention, verbatim - the contact person the document is addressed to.';
COMMENT ON COLUMN scm.mfg_sales_orders.ac_to_po_no       IS 'AutoCount SO.UDF_ToPONo, verbatim: the PURCHASE ORDER(S) AUTOCOUNT RAISED FROM THIS ORDER, comma-joined. NOT a customer PO number.';
COMMENT ON COLUMN scm.purchase_orders.attention          IS 'AutoCount PO.Attention, verbatim.';
COMMENT ON COLUMN scm.purchase_orders.display_term       IS 'AutoCount PO.DisplayTerm, verbatim.';

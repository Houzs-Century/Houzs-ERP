-- ----------------------------------------------------------------------------
-- 20260914T0200 — a purchase invoice line KEEPS the price its purchase order
-- named, beside the price the supplier billed.
--
-- WHY. Owner, 2026-09-14: 「只要我 edit 过了，系统就直接把原来的 PO 价钱留痕下来」
-- — the PO price on the invoice is a reference trail: the invoice price is free
-- to edit, and the PO price beside it must still say what the order said.
--
-- Until now the detail page read that price LIVE through the join
--   purchase_invoice_items.grn_item_id -> grn_items.purchase_order_item_id
--     -> purchase_order_items.unit_price_sen
-- which answers "what does the order say TODAY". An approved purchase-order
-- amendment writes unit_price_sen on a line that has already been received and
-- invoiced (po-revision.ts applies PRICE with no received floor), so the trail
-- on an existing invoice would silently change under it. A stored copy does not.
--
-- NULL means "no snapshot taken": either the line has no purchase order behind
-- it (a PI-native line, a receipt taken without a PO), or it was written before
-- this column existed. The read path distinguishes those by the link, not by
-- this column. 0 is a real snapshot: the order named no price (68% of the
-- AutoCount-migrated Houzs lines, measured 2026-09-12 — docs/bugs/0845).
--
-- Written ONLY by the server at line insert (lib/pi-po-price.ts
-- stampPoPriceSnapshot), never from a request body and never by a line PATCH.
-- Existing rows are back-filled by backend/scripts/backfill-pi-po-unit-price.mjs
-- (plan by default), not here: a numbered migration does not write business data.
--
-- REVERSAL: ALTER TABLE scm.purchase_invoice_items DROP COLUMN po_unit_price_sen;
--           (Additive and nullable. Dropping it loses the stored trail; the
--           detail page falls back to the live join it used before.)
--
-- Verified against: production schema read 2026-09-14 (read-only DSN,
-- default_transaction_read_only=on) — scm.purchase_invoice_items has
-- unit_price_sen, grn_item_id and no column named po_unit_price_sen.
-- ----------------------------------------------------------------------------

ALTER TABLE scm.purchase_invoice_items
  ADD COLUMN IF NOT EXISTS po_unit_price_sen integer;

COMMENT ON COLUMN scm.purchase_invoice_items.po_unit_price_sen IS
  'Unit price (sen) the source purchase-order line named when this invoice line was written. Reference only; NULL = no snapshot (no PO behind the line, or written before 20260914T0200). Set by the server at insert, never edited.';

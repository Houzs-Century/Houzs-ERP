## A delivery order showed the sales order's customer date as its delivery date, not AutoCount's [high]

**Symptom.** `HC-DO-011559` (customer ref HC12445) showed **Expected Delivery
05/09**, **Customer Delivery Date 05/09** and **Scheduled 05/09**, while AutoCount
(`DO-011559`) held the document AND every line's delivery date as **19/09** — the
same as the DO's own document date. The DO's own date (`do_date`) was correct
(19/09); only the two delivery-date fields were wrong. Owner 2026-09-11:
「全部要跟 autocount」.

**Root cause (traced).** The DO's `expected_delivery_at` and
`customer_delivery_date` were copied from the SALES ORDER's `customer_delivery_date`
— the date the customer originally asked for (05/09), not the delivery order's own
date (19/09). Two places did it, both a deliberate 2026-09-08 default
(docs/bugs/0716, 0723) that this reverses:
- the ongoing SO->DO conversion — `delivery-orders-mfg.ts` set
  `expected_delivery_at`/`customer_delivery_date` to `head.customer_delivery_date`
  (the SO header);
- the migrated-DO backfill — `scripts/lib/customer-block.mjs` `DO_SALES_CARRY`
  carried `s.customer_delivery_date` / `COALESCE(s.customer_delivery_date, d.do_date)`.

The delivery-planning board's demand order runs off the SALES ORDER's date, not
the DO's, so this was a DISPLAY defect on the delivery order (the "Scheduled" /
"Expected" labels and the DO-list sort), not a scheduling one.

**Fix.** Both sources now use the DO's own `do_date` (= AutoCount's DocDate) for
both date fields. The customer's original ask is NOT lost — it still lives on the
sales order (`scm.mfg_sales_orders.customer_delivery_date`). A one-time repair
(`repair-do-delivery-dates-to-autocount.mjs`, workflow "Repair DO delivery dates
to follow AutoCount", PLAN by default, apply needs `CONFIRM=DO-DATES-FOLLOW-AUTOCOUNT`)
sets existing AutoCount-linked DOs (`linked_ac_docno IS NOT NULL`) to their own
`do_date` where they differ, and verifies zero remain on a fresh connection.

**Caveat (known).** AutoCount's per-LINE delivery date is not mirrored (the DO
header pull carries only `DocDate`); `do_date` is used as the faithful proxy,
correct whenever AutoCount's line delivery date equals its doc date, which is the
case here and the norm for a delivery order. A DO whose AutoCount line delivery
date genuinely differs from its doc date would need the line-level date mirrored —
a separate change, not seen in this defect.

**Ref.** `fix/ac-do-delivery-date`, 2026-09-11. Reverses the delivery-date half of
docs/bugs/0716 / 0723.

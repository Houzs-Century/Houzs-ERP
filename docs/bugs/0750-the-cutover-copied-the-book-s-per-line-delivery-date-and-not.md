## The cutover copied the book's per-line delivery date and not the switch that makes it count [medium]

<!-- area: Cutover + migrated data -->
<!-- status: owner-decision -->

**Symptom.** The ERP promises a customer the HEADER delivery date while the
account book gives that line its own, later date. Worst measured gap: `HC-SO-001920`
(ALVEN) — AutoCount says 2025-09-13 on four lines, the ERP promises 2025-07-19.
**Fifty-six days early**, on a live CONFIRMED order.

**Root cause (traced).** `effectiveSoDelivery` (`shared/effective-delivery.ts`)
uses a line's own date only when `line_delivery_date_overridden` is true:

```ts
if (overridden === true && lineDate !== null) return lineDate;
return amended ?? customer ?? lineDate;
```

The cutover copied AutoCount's `SODTL.DeliveryDate` into `line_delivery_date`
and left the switch false, so the date is stored and ignored. The live write
paths are NOT at fault — `mfg-sales-orders.ts` sets the switch true whenever a
line date is sent, and `consignment-notes`, `consignment-orders` and
`delivery-orders-mfg` all do the same.

**THREE POPULATIONS LOOK IDENTICAL IN SQL, AND ONLY ONE MAY BE REPAIRED.** Nine
live lines carry a line date with the switch off and a date differing from the
header. Each was read against the book one by one over ZeroTier:

| | what it is | action |
| --- | --- | --- |
| **6** | the book confirms a different per-line date | **repair** |
| 1 | `HC-SO-000517` SOFT PILLOW reads 2026-08-28 in the ERP; **all six lines of `SO-000517` read 2026-08-27 in AutoCount**. The date is in no book row | leave |
| 1 | `2990-SO-2607-023`'s line date EQUALS its customer date (2026-10-05) — a mirror. The order was later amended EARLIER to 2026-08-08 and the cascade watches `customerDeliveryDate`, not `amendedDeliveryDate`, so the line kept the pre-amendment value | leave |

A blanket "set the switch where the dates differ" would have pushed a
READY_TO_SHIP order **two months later** and invented a day of delay on another.
The repair therefore PINS the six by `(doc_no, item_code, book date)` and refuses
if the tree stops matching.

**And the guard earned its keep on the first run.** The list was seven when it
was written. The plan found six and REFUSED: `HC-SO-013495` (MR JERALD) had its
dates CLEARED by somebody between the measurement and the repair —
`customer_delivery_date`, `amended_delivery_date` and both line dates are now
NULL, while the book still says the sofa is due 2026-10-10 and the pillow
2026-09-08. That order has moved from "the line date is ignored" to **"the ERP
promises nothing at all"**, which is a different problem and is NOT repaired
here.

**Same-class sweep — asked for by the owner, and it is clean.** Four tables carry
`line_delivery_date` + `line_delivery_date_overridden`:

| table | switch off | of those, date differs |
| --- | ---: | ---: |
| `mfg_sales_order_items` | 3,086 | **9** |
| `delivery_order_items` | 6 | 0 |
| `consignment_sales_order_items` | 0 | 0 |
| `consignment_delivery_order_items` | 0 | 0 |

The other 3,077 sales-order lines carry the header date as a mirror, so ignoring
them changes nothing. **The problem exists in exactly one table.**

**Fix.** `backend/scripts/repair-line-delivery-date-override.mjs` turns the
switch on for the six. Plan by default; apply needs a confirm phrase; the
verification re-reads on a fresh connection and asserts the SHAPE — that each
line's EFFECTIVE date is now its own date, recomputed with the same precedence
`effectiveSoDelivery` uses — and separately asserts the two look-alikes were NOT
touched.

**REVERSAL:** `SET line_delivery_date_overridden = false` on those ids. Every
target was false; no date is written, only the switch.

**Left open for the owner:** `HC-SO-013495` now carries no delivery date at all
while the book carries two, and the amendment cascade ignoring
`amendedDeliveryDate` is a latent trap — today it is harmless only because the
switch stays off.

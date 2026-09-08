## Money collected at the door never reaches the account book [high]

**NOT FIXED IN THIS PR — and deliberately so.** What ships here is the
measurement, because the choice between the three repairs depends on a number
nobody has ever taken, and one of the three (writing payments into the book) is
the single most dangerous class of change on this cutover. The ruling is the
owner's.

**Symptom.** A customer pays the driver at the door. Logistics key it on the
delivery order. AutoCount is never told, so the account book goes on showing
that customer as owing the full amount — and the owner's go-live requirement was
「然后确保Autocount也会钱收到」.

**Root cause (traced, not guessed).** The AutoCount payment path is bound to one
table, and it is not the one the delivery screen writes to.

```
backend/src/scm/lib/autocount-read.ts:65   readSoOutstandingSen -> scm.mfg_sales_order_payments   (the BALANCE)
backend/src/scm/lib/autocount-read.ts:187  readSoPaymentRefs    -> scm.mfg_sales_order_payments   (the PAYEMENT text)
```

`composePaymentUdf` has exactly two feeders —
`backend/src/scm/lib/so-edit-header.ts:187` and
`backend/src/services/autocount-writeback.ts:1284` (composeCreateSo) — and both
are fed from those two reads. Nothing on any AutoCount path mentions
`scm.delivery_order_payments` in any form.

Meanwhile that table is written by a LIVE screen, not by dead code:

```
backend/src/scm/routes/delivery-orders-mfg.ts:5243   POST /delivery-orders-mfg/:id/payments -> insert
frontend/src/vendor/scm/lib/delivery-order-queries.ts:417-470
    useDeliveryOrderPayments / useAddDeliveryOrderPayment / useDeleteDeliveryOrderPayment
    -- its own comment: "The DO Create + Detail screens render the same Houzs PaymentsTable"
```

So the money is taken by a reachable screen and stops at our database.

**Why the row cannot even be company-scoped the ordinary way, which is the same
fault line that hid this before.** `scm.delivery_order_payments` carries no
`company_id` of its own; it is scoped through its parent delivery order. That is
exactly why the 2990 importer silently dropped 13 of these rows — its generic
guard `if (!dcols.includes("company_id"))` skips any destination table without
the column, and it printed `SKIP delivery_order_payments: no company_id` while
everything else migrated. Traced in full in
`backend/scripts/diag-do-payments.mjs`, written for the owner's 2026-07-24 ask.
The same table has now been missed twice by two different mechanisms, for the
same structural reason.

**What the owner already said about this shape**, and it is the reason the fix
is not obvious: 2026-07-24, 「our payments are all recorded on the Sales
Order」. If that is still the operating rule, the right answer may be to close
the delivery-order payment screen rather than teach it to write into the book.
If it is not — if drivers really do collect at the door — the money has to
reach AutoCount. The measurement decides which world we are in, and the
measurement did not exist.

**Shipped here.** `backend/scripts/check-do-payment-book-gap.mjs` +
`.github/workflows/check-do-payment-book-gap.yml` — read-only, SELECT only,
manual trigger, own concurrency group, exit 0 for every legitimate answer. It
cuts every company-1 delivery payment into three buckets:

- **(a)** the same amount on the same day is ALSO on the sales order — the book
  already knows it, no gap;
- **(b)** it is not on the sales order — the book has never seen this money, and
  the sub-count "…of which the order IS in the book" is the honest exposure;
- **(c)** the delivery order carries no sales order at all — reported on its own
  rather than folded into either answer, because an unmatchable row is evidence
  that the script cannot tell, never evidence of additional money.

**UNTESTED against production at the time of writing** — the workflow exists and
has not been dispatched. Whatever it prints goes into this entry.

**Ref.** PR pending, 2026-09-08.

Related, and together they make the shape plain — money moves between the two
systems in two directions and BOTH have a hole:

- `docs/bugs/0678-nothing-carries-an-autocount-payment-back-to-the-erp-once-th.md`
  — INBOUND: a payment taken in AutoCount never reaches the ERP, so we chase a
  customer who has paid.
- this entry — OUTBOUND: a payment taken at the door never reaches AutoCount, so
  the book chases a customer who has paid.
- `docs/bugs/0675-the-erp-s-paid-figure-was-never-observed-so-a-corrected-tota.md`
  — why the ERP's own `paid_sen` cannot be used as a referee for either: it was
  never observed, only derived as total minus balance at import time.

Module guide: `docs/modules/autocount-writeback.md`.

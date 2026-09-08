## The migrated delivery order never carried a customer block so a driver has no phone and no address [high]

<!-- area: Cutover + migrated data -->
<!-- status: fixed -->

**Symptom.** Delivery orders opened to staff on 2026-09-08 at 17:41 and the
owner sent a screen of `HC-DO-011556`, converted from `HC-SO-013124`, customer
"Dane". Phone, email and address all render `—`. **A driver cannot deliver from
that document**, whatever its figures say.

**Root cause (traced).** `backend/scripts/lib/migrated-do-writer.mjs`'s header
INSERT names fourteen columns:

```
do_number, so_doc_no, debtor_code, debtor_name, status, do_date, currency,
company_id, created_by, notes, migrated_no_stock, linked_ac_docno,
warehouse_id, sales_location
```

Not one of them is `phone`, `email`, `customer_type`, `address1`, `address2`,
`city`, `state`, `postcode` or the emergency contact — and `scm.delivery_orders`
has every one of those columns. The interactive create path fills them
(`backend/src/scm/routes/delivery-orders-mfg.ts:3459`, ~30 assignments), and
`backend/src/scm/lib/so-to-do-fields.ts` is the module that already owns *what
an SO carries into a DO* for both live converters. The migrated writer simply
never asked it. So the block is absent by construction on **every** document
that writer produced, through either of its two callers
(`create-migrated-documents.mjs` and `sync-ac-delta.mjs`).

This is the identical shape as `docs/bugs/0617`, in the same INSERT: the price
columns were omitted there for the same reason — the statement names the columns
the author thought about, and a column nobody names is silently NULL.

**It is not a book gap.** The book holds the customer on the document. For
`SO-013124` the committed cut `backend/scripts/data/ac-doc-headers.json.gz`
carries `DebtorCode`, `DebtorName "Dane"`, a `Phone1` and `InvAddr1..3`, and the
sales-order importer copied them onto `HC-SO-013124`. The parent order has the
block; the delivery order it produced does not.

**Why the owner's delivered-order ruling does not cover it.** He ruled the same
day 「已经出货了的就随便把 不去关注了 留个底记录而已 数据对不对不重要了」 — for
lines already delivered, do not spend effort on accuracy. `SO-013124` is fully
delivered (all four book lines have `transferedQty = qty`), so that ruling covers
its DATA, and this lane reconciles none of its lines, quantities or money. What
it repairs is the PAPERWORK: a delivery note with no phone and no address is
unusable as a document even when its figures do not matter.

**Fix.** Two halves, and neither is the other.

1. **Stops recurring.** `insertMigratedDo` now copies the block from the parent
   sales order in the same transaction — one `UPDATE ... FROM
   scm.mfg_sales_orders`, folding the order's four address lines into the
   delivery order's two exactly as `so-to-do-fields.ts` does. Nothing is
   defaulted: a field the order does not carry stays NULL, which is the honest
   rendering. Pinned by `backend/tests/migratedDoWriter.test.mjs`
   ("the customer block on a migrated delivery order"), **proved RED against the
   unfixed file** — 2 of the 3 new cases fail on `HEAD`'s copy of the writer.
2. **Repairs what is already written.** `backend/scripts/repair-customer-block.mjs`
   + `.github/workflows/repair-customer-block.yml`, plan by default, apply gated
   on `CONFIRM="CARRY THE CUSTOMER BLOCK"`. Every UPDATE carries its own
   emptiness predicate, so a value a human filled is invisible to it, and a field
   neither the order nor the book states is left blank and counted. It writes no
   line, quantity, price, payment column or status, and enqueues no AutoCount
   outbox row (owner 2026-09-08: 「写回autocount的你不需要理了」).

The size of the class is measured by
`backend/scripts/check-customer-block-gap.mjs` +
`.github/workflows/check-customer-block-gap.yml`, read-only.

**Sized, then closed, on production.** Probe run
[`34221966031`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34221966031)
(19:38 Malaysia): **173 of 185 company-1 delivery orders carried no phone and no
address at all** — every one of them written by that writer, none created by a
human, and every one answerable from its parent sales order. 0 were unanswerable
and 0 were half-filled.

Apply run
[`34222124527`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34222124527)
wrote 175 delivery-order headers (173 needing the whole block, 2 needing only a
city) in one transaction, and verified on a FRESH connection: `0` fields not the
value planned, `0` disagreeing with the parent sales order, `0` still without a
phone and an address. The control block was read on that same fresh connection —
document counts, line counts, quantities, money, inventory movements and the
READY/PENDING/PARTIAL allocation — and `control rows moved: 0`. Re-measured by
probe run
[`34222237940`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34222237940):
**173 -> 0**.

The AutoCount reconcile was **14 disagreements** two minutes before the apply
([`34221922832`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34221922832))
and **14** after
([`34222294313`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34222294313)),
with field identity 71 differ / 76 ERP-blank on both sides. Unmoved, which is the
correct result: a customer block on a delivery order is not a line, a quantity or
an amount.

**Ref.** fix/customer-info-gap, 2026-09-08. Full before/after:
`docs/customer-block-gap-2026-09-08.md`.

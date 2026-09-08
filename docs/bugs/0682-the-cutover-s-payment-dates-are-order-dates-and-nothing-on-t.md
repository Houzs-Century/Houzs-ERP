## The cutover's payment dates are order dates and nothing on the row said so [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Every migrated company-1 sales order carries one payment row whose
`paid_at` is the ORDER date. `HC-SO-002309` (CHOW AH SIN) is dated **2024-08-11**
— the day the order was written, not a day any money arrived. Nothing on the row
says so, so a reader, a report or a cash close takes it for a receipt date.
`docs/bugs/0675` and `0678` both recorded that the date is fabricated; neither
put that fact where a reader of the row would meet it.

**Root cause (traced).** `backend/scripts/import-ac-outstanding-so.mjs:476`
builds the payment row and has no payment date to put in it:

```js
if (o.paid > 0) { pv.push("(" + [V(o.docNo), h.DocDate ? V(h.DocDate) : V(CUR), V("imported"), ...
```

The second column of `PCOLS` is `paid_at`, so `h.DocDate` — AutoCount's document
date — becomes the payment date, with today's date as the only fallback. That is
not a defect in the importer: **AutoCount records only what is still OWED**
(`UDF_BALANCE`) and carries no date on which money arrived, so there was nothing
truer to copy. The same header write puts `h.DocDate` into
`scm.mfg_sales_orders.payment_date`.

**Why it is worth a write rather than a doc line.**
`backend/src/acc/daily-close.ts:55-63` buckets payments with
`.gte('paid_at', dayStart).lte('paid_at', dayEnd)`, so an unlabelled fabricated
date lands in a day's cash close as if that money had been counted that day, and
any ageing of a receivable off `paid_at` reads an order date as a receipt date.
The label is the only thing standing between those two readings.

**The owner's ruling, 2026-09-08.** Leave the dates — the book does not hold a
payment date and one must not be invented — but **LABEL** them.

**Fix.**

- `backend/scripts/label-migrated-payment-dates.mjs` +
  `.github/workflows/label-migrated-payment-dates.yml` — plan by default,
  `CONFIRM=label-fabricated-payment-dates` to write. It appends
  `[DATE NOT OBSERVED: this is the ORDER date, not a payment date - the
  AutoCount cutover had no payment date to copy]` to the row's `note` and
  touches no amount, no date and no status. A row is labelled **only** where
  `paid_at` provably equals its order's `so_date` — that equality is the
  evidence the date is the fabricated one; a migrated row whose date differs
  came from somewhere the script cannot name, so it is listed and left alone.
  Every `UPDATE` is guarded on the exact note the plan read, and the read-back
  is on a FRESH connection asserting the shape: nothing provable left
  unlabelled, and no amount or date moved.
- `backend/scripts/repair-so-payment-from-book.mjs` — the `settle-collected`
  ruling writes a payment row dated the book's `LastModified`. That is a real
  stamp but it is an **edit** date, not a receipt date, so its note now carries
  the same `DATE NOT OBSERVED` marker. One grep for that marker now finds every
  date on this ledger that nobody observed.

**Safe for every reader, checked by enumeration rather than assumed.** All six
code sites that key on the importer's note match it by PREFIX —
`check-so-payment-census.mjs:168` and `repair-so-payment-from-book.mjs:173`
(`LIKE 'imported from AutoCount%'`), `check-so-version-provenance.mjs:410` and
`sync-ac-delta.mjs:455` (`/^imported from AutoCount/`),
`probe-so-payment-reconcile.mjs:205` (`startsWith`) and
`remove-delivered-imported-so.mjs:63` (`LIKE 'imported from AutoCount%'`). A
SUFFIX leaves every one of them matching exactly as before, which is why the
label is appended and the note is never rewritten. In particular the
`n_human` filter that decides whether a PERSON owns a payment row keeps
classifying these rows as the importer's, so the census and the repair guard
are unaffected.

**What is NOT fixed here.** `scm.mfg_sales_orders.payment_date` carries the same
fabricated date and is left as it is: it is an operator-editable form field
(`mfg-sales-orders.ts:5182`), not a ledger row, and overwriting a field staff
can type in is not this script's to do.

**Ref.** `fix/so-payment-book-align`, 2026-09-08.

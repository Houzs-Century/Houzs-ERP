## AutoCount's sales-order line discount is dropped the same way the purchase side's was [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** A customer's order says RM 10,852.00 in the ERP and RM 9,876.00 in
the account book. From the go-live reconcile, run `34185154444`:

```
SO-000021: AutoCount RM 9876.00 vs ERP RM 10852.00 (ERP HC-SO-000021)
```

Every line of it PAIRS, the item codes agree, the quantities agree and the unit
prices agree — which is why nothing but the document total said a word.

**Root cause (traced).** AutoCount keeps a line discount in the gap between
`SODTL.UnitPrice` and `SODTL.SubTotal`, and the importer computes the line
amount out of the undiscounted half. Read off the committed snapshot beside
production, probe run `34186980493`:

```
### SO-000021 -> HC-SO-000021  book 3 line(s) / RM 9876.00   ERP 3 row(s) / header RM 10852.00
  BOOK key=13555 "DL-D.ULTIMATE SANTUARY (K)"  qty=1 unit=RM 9298.00 sub=RM 9099.00
      -> ERP "DUNLOPILLO DS ULTIMATE SANCTUARY MATT MATT (K)" qty=1 unit=RM 9298.00 total=RM 9298.00
  BOOK key=13556 "DL-ECO COMFORT LATEX PILLOW"  qty=2 unit=RM 598.00 sub=RM 598.00
      -> ERP qty=2 unit=RM 598.00 total=RM 1196.00
  BOOK key=13557 "DL-MP(K)"  qty=1 unit=RM 358.00 sub=RM 179.00
      -> ERP qty=1 unit=RM 358.00 total=RM 358.00
```

RM 199.00 + RM 598.00 + RM 179.00 = **RM 976.00**, which is the difference to
the sen. This is `docs/bugs/0662` — the purchase-order line discount — on the
sales side, where nobody had looked.

**How big it is.** Measured over the whole book on the 2026-09-08 08:03 Malaysia
cut: **38 discounted sales-order lines across 20 documents, RM 13,990.00**, of
which **3 lines on 1 document (RM 976.00) are in the outstanding scope**. The
population the repair actually walks is what the ERP HOLDS (docs/bugs/0694), so
the plan run reports the real number rather than this one.

**Fix.** `backend/scripts/repair-so-line-discount.mjs` +
`.github/workflows/repair-so-line-discount.yml`, plan by default. It writes
`discount_sen`, `total_sen`, `total_inc_sen` and `balance_sen` on the line and
re-sums `local_total_sen` plus the five category buckets on the header —
together, because `mfg-sales-orders.ts:4251` computes
`lineTotal = senOrZero((qty * unit) - discount)` and a line amount corrected
without the discount beside it is recomputed away by the next UI edit.

Four refusals, each planted in `backend/tests/soDiscountPlan.test.mjs`: a
decomposed sofa group (one discount would be subtracted once per compartment —
the same trap that made `repair-so-price-from-autocount`'s first dry run propose
+RM 2,216,501.00 across 441 rows), an ERP line whose own qty x unit price is not
the book's, a book amount ABOVE qty x unit price, and a line whose goods have
already been DELIVERED. The header's `paid_sen` / `balance_sen` are never
touched and an inconsistency is NAMED for the owner.

`12 passed (12)` on the plan library; `No new violations` from
`npm --prefix backend run audit:release-discipline`.

**Ref.** fix/so-do-money-reconcile, 2026-09-08.

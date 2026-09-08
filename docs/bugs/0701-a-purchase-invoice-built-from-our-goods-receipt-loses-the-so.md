## A purchase invoice built from our goods receipt loses the sofa build text [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Three of the four documents the keyless verifier cannot decide are
purchase invoices, and all three fail for the same reason: there is no build text
to group their sofa compartments by. Run `34191920800`, 2026-09-08:

```
PI-005959 (ERP HC-PI-005959) — book 1 line(s), ours 5
   why: SOFA 9058: the book says qty 1, and our side folds to between 1 and 2
        whole sofa(s) — no usable build text, and our quantities inside one
        build are uneven (1A(LHF) x1, 1A(RHF) x1, 1NA x2, CNR x1)
   ── the book ──
   seq 16  DSL-9058 SOFA  qty 1  RM 2750.00  build: CH141-1 (CREAM)/30"/1R+1NA+1NA+C+1R
   ── ours ──
   9058-1A(LHF)  qty 1  RM    0.00  build: (none)
   9058-1NA      qty 1  RM 2750.00  build: (none)
   9058-1NA      qty 1  RM    0.00  build: (none)
   9058-CNR      qty 1  RM    0.00  build: (none)
   9058-1A(RHF)  qty 1  RM    0.00  build: (none)
```

The book states the build. Its own goods receipt, `GR-003922`, carries that text
on every compartment row on OUR side too — the same run prints it. The purchase
invoice built from that receipt carries `(none)`.

**Root cause (traced).** `scm.purchase_invoice_items.description2` is null on
every purchase-invoice row this run printed — six documents, twenty-two rows,
`PI-001531`, `PI-005959`, `PI-007252`, `PI-007875`, `PI-007894` and `PI-007918`.
Purchase-invoice lines come from OUR goods receipt, not from AutoCount `PIDTL`
(the reconcile declares this as `migratedChainLineShape`), and the conversion
does not carry `description2` forward. Corroborating evidence in the same run:
the COMPARTMENT-SHAPE column is 5 on sales orders, 1 on goods receipts, 5 on
delivery orders — and **0 on purchase invoices**, because with no stored build
text there is never a decode for our rows to disagree with.

**PROVEN** for those twenty-two rows. **LIKELY**, not proven, for the whole
table: this run only reads the 31 keyless purchase invoices, so a census of
`scm.purchase_invoice_items` has not been taken.

**Cost, plainly.** Nothing on the invoice is WRONG — model, quantity and money
all agree with the book on 25 of the 31. What is lost is the ability to say
which compartments were one sofa, so any check that has to fold a purchase
invoice's sofa rows has to say "I cannot tell" instead of answering. It also
means the AutoCount write-back's ECHO path has no original text to echo for a
purchase invoice, and would have to COMPOSE — the lossy route
`autocount-sofa-collapse.ts` exists to avoid.

**Fix.** NOT FIXED HERE — named, sized and handed over rather than patched
blind. The repair is to copy `description2` from the source `scm.grn_items` row
during the goods-receipt-to-purchase-invoice conversion, and to backfill the
existing rows the same way. Both are a COPY from a row we already hold, never a
recomputation, so `migration-copy-never-compute` is satisfied. It is not done in
this PR because the conversion is another lane's surface today (`#3199` is
stamping AutoCount line numbers onto exactly these migrated downstream rows) and
two lanes writing the same columns is how a repair overwrites a repair.

**Ref.** `fix/keyless-sofa-desc2-fold`, 2026-09-08. Found by `docs/bugs/0695`'s
verifier.

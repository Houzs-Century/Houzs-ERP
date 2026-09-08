## A sales order carries a STORAGE line claiming a DtlKey the book does not have [high]

**Symptom.** `SO-013160` is the only sales order where the ERP holds MORE lines
than the book: AutoCount 3, ERP 4. The reconcile reports it twice — once as a
line-count difference and once as money, `AutoCount RM 300.00 vs ERP RM 600.00`
— and once more as the single orphan DtlKey on the whole run:

```
SO-013160: ERP line 222041a0-b27b-4f59-b668-155b2af1a780 claims DtlKey 892917,
           not a line of this document
```

**Root cause (traced).** The book's `SO-013160` has exactly three lines,
892914/892915/892916, totalling RM 300.00 — a bedframe at RM 0.00, a
`Miscellaneous` at RM 0.00 and `TRANSPORTATION CHARGES` at RM 300.00. Our copy
carries all three correctly and a fourth row, `STORAGE` RM 300.00, which claims
key 892917.

Searched offline across the whole committed book cut: **`892917` is not a
sales-order line key anywhere**, not on this document and not on any other.

```
=== does 892917 exist anywhere in SO? ===
[]
```

So the row is not a mis-attached line from a neighbouring order — the key it
claims does not exist in `SODTL` at all. The ERP overstates this customer's
order by RM 300.00 and the doubled figure is a duplicate of the transportation
charge already on the document.

**Fix.** Not fixed here. Deleting a line that carries RM 300.00 is not a
unilateral call: the storage charge may be real and merely recorded against the
wrong order, in which case removing it loses money rather than correcting it.
The owner rules. What is PROVEN and recorded here is that the book has no such
line and no such key.

**Ref.** fix/cutover-127-sweep, 2026-09-08. Probe run `34188565498`
(`SO-013160`, each book line beside its ERP row); key search run offline against
`backend/scripts/data/ac-reconcile-truth.json.gz`.

## The last two sales-order quantity differences are not quantity differences — no ERP line exists for either book line [medium]

<!-- area: Cutover + migrated data -->

**Symptom.** `check-ac-erp-reconcile` against prod, 2026-09-08 00:12 local:

```
SO DATA (2882 documents on both sides, 14862 lines paired) — ... quantity: 2
   quantity (first 2 of 2):
      SO-000814 DtlKey 58981: AutoCount qty 0 vs ERP qty 1
      SO-012128 DtlKey 924549: AutoCount qty 4 vs ERP qty 1
```

The plan was to give those two lines their `linked_ac_dtlkey` with
`backfill-ac-line-keys` and let the existing quantity repair reach them, because
a repair writes by key and these two are paired heuristically.

**`backfill-ac-line-keys` has nothing to write.** Dry-run against prod, same
sitting:

```
SO lines: erp lines 15050; to set 0; already set 13503; no AC match 1533; count mismatch 14
```

**Root cause (traced, not guessed).** Neither AutoCount line has an ERP row to
key, and the "ERP qty 1" on both is a row belonging to a *different* book line.

| book line | what it actually is | what the ERP holds |
|---|---|---|
| `SO-000814` DtlKey **58981** | **no item code, qty 0, unit 0**, Desc2 `LEG: FOLLOW DISPLAY` — a free-text note row | nothing, and nothing should |
| `SO-012128` DtlKey **924549** | `HOK-SQUARE PILLOW` **qty 4 @ RM 0.00**, Desc2 `FOR CONPESSANTION WRONG ITEM DELIVERY` | **no pillow line at all** |

The pairing comes from `check-ac-erp-reconcile.mjs`'s keyless fallback, which
tries `(qty, unit price)`, then `qty`, then **document order**. Both book lines
fall through all three and land on the third pass, where they are matched
against a **sofa compartment**:

```
SO-000814  free ERP rows: 5526-1NA (qty 1), 5526-2A(RHF) (qty 1)   <- compartments of DtlKey 58980
SO-012128  free ERP rows: 9028-1A(RHF) (qty 1)                     <- compartment of DtlKey 833309
```

So "AutoCount qty 0 vs ERP qty 1" is a note line held against a sofa piece, and
"AutoCount qty 4 vs ERP qty 1" is four free compensation pillows held against
another. Repairing a quantity on that pairing would write a book line's
quantity onto a compartment of a sofa.

**Outcome: STOPPED, deliberately.** There is no key to establish, so there is
nothing to repair by key. What is left is two separate facts, neither of them a
quantity:

1. `HC-SO-012128` is **missing four free compensation pillows** the customer is
   owed (`HOK-SQUARE PILLOW`, RM 0.00). That is a real gap and it is the
   owner's to confirm before anything is inserted — the ERP has no line to
   correct, only a line to create.
2. `SO-000814` DtlKey 58981 carries no item code and no quantity. Nothing should
   exist for it, and the honest report is `has no ERP line`, not a difference.

The same shape sits on the delivery side of the same reconcile and is untouched
for the same reason: `DO-011465 DtlKey 924550` (qty 4 — the delivery of those
same pillows) and `DO-001604 DtlKey 199271` (qty 0).

**The available next step, priced but not taken.** Giving the sofa COMPARTMENTS
their build's DtlKey would remove the false pairing, and
`backfill-ac-sofa-line-keys` is the tool: dry-run against prod reads
`SO sofa lines: ... rows to key 33; no AutoCount line 50; count mismatch 38` and
`PO sofa lines: ... rows to key 17`. That is a 50-row write of LINE IDENTITY,
which is what the AutoCount write-back's `/edit` addresses rows by, and it
changes no quantity and creates no pillow. Not run mid-go-live on a session that
was asked for two keys.

**Ref.** docs/cutover-keys-and-ledger, 2026-09-08.

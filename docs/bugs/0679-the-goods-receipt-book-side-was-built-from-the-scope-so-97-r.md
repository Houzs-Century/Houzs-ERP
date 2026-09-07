## The goods-receipt book side was built from the scope, so 97 receipts the book states were reported as phantom [medium]

**Symptom.** `check-ac-erp-reconcile.mjs`, run **34148510412** (2026-09-07 01:40
local) and again unchanged on run **34157241944** (2026-09-08 03:52 local):

```
GR   book 400   scope 400   erp 497   absent 0   phantom 97
GR DOCUMENTS — ERP claims a document the book does not have: 97
   out-of-scope and absent (CORRECT by the population rule): 0;
   present though out of scope: 0; duplicate claims: 0
```

Read literally that sentence says the ERP fabricated 97 goods receipts, which
would be stock claimed to have arrived that the account book never recorded.

**Root cause (traced).** `grPairGrain()`, inline in
`backend/scripts/check-ac-erp-reconcile.mjs`, built the BOOK side and the
EXPECTED POPULATION in **one filtered loop**:

```js
for (const gr of SCOPE.GR) {                                   // in-scope receipts only
  for (const l of book.GR.lines.get(gr) || []) {
    if (l.fromDocType !== "PO" || !l.fromDocNo || !SCOPE.PO.has(l.fromDocNo)) continue;
    ...
    scope.add(key);                                            // same key, same loop
  }
}
```

Every key put into `headers` was also put into `scope`, so the two came out the
same set — which is why the report printed `book 400 scope 400`, and why the two
categories that exist to absorb a legitimate out-of-scope document,
`absentOutOfScope` and `outOfScopeMirrored`, were **both structurally
unreachable** and printed 0. The classifier has three outcomes; one of them could
never occur, so every ERP claim outside the population fell through to the third
and was printed as a document the book does not have.

**Proved, not reasoned.** A local probe over the committed snapshot
`ac-reconcile-truth.json.gz` (exported 2026-09-07 22:12 local) tested all 20
named pairs against the RAW book: **20 of 20 have the receipt header AND the
exact (receipt → PO) edge.** The only thing true of them is that the purchase
order sits outside `SCOPE.PO` — 484 orders, against the **574** the ERP holds.
Eleven of the 20 are receipts out of scope entirely, which a loop over `SCOPE.GR`
cannot reach at all. The whole book holds **11,623** pairs against the 400 the
old code called "the book".

The claims are not even documents: the run reports `GR — ERP: 0 documents;
0 mirror an AutoCount document; 497 more are referenced by a pointer`. All 497
come from the `pointers` query, `unnest(purchase_orders.linked_ac_grn_docnos)`,
which is why every phantom line names an `HC-PO-…` number.

**Fix.** The rule moves to `backend/scripts/lib/ac-gr-pair-grain.mjs` and returns
the two halves separately: `view` is the whole book at pair grain (11,623),
`scope` is the in-scope subset (400), still `SCOPE.GR ∩ SCOPE.PO` from
`lib/ac-scope.mjs` so the pair population cannot drift from the document
population. This is the convention every other type already used — PO reports
9,416 in the book against 484 in scope.

Pinned by `backend/tests/acGrPairGrain.test.mjs`, **proved RED on the unfixed
tree**: restoring the single filtered loop fails 3 of its 6, including

```
AssertionError: expected [ 'GR-001|PO-OUT', 'GR-002|PO-OUT2' ] to deeply equal []
```

which is the 97 in miniature — two pairs the book states, reported as invented.

**What this does NOT fix, found while proving it.** The same run says
`GR DATA (0 documents on both sides, 0 lines paired)` and
`GR VARIANTS — nothing was compared. NOT a clean run.` The contents comparison
the reshape (#3123) exists to enable is still producing nothing, because
`reshape-migrated-grns.mjs` **has never been applied**: its only two production
runs, **34144660307** and **34144939745** (2026-09-08 00:44 and 00:48 local), both
logged `MODE: plan`, and the second reported `ERP — 320 migrated goods receipts,
591 lines, 879 units, on 320 purchase orders` with `distinct received_at values:
3 — 2026-08-28, 2026-08-29, 2026-09-07`. So the ERP still holds the pre-reshape
shape, no row carries `linked_ac_gr_docno`, the reconcile's `docs` query returns
zero rows, and `bothSides` is 0 because it iterates `erpByAc`. Applying the
reshape is an owner decision (it would CREATE 153 documents and UPDATE 247) and
is deliberately left un-run here.

**Ref.** fix/gr-phantom-97, 2026-09-08.

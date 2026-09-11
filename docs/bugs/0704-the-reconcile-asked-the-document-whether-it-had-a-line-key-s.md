## The reconcile asked the DOCUMENT whether it had a line key, so a guessed goods-receipt pairing was counted as a wrong product [medium]

<!-- area: Cutover + migrated data -->
<!-- status: fixed -->

**Symptom.** The go-live reconcile has reported `GR ... item code: 2` since the
line-key backfill landed, and printed the two rows with no explanation beside
them — not as a guessed pairing, not as an impostor, just counted. Both are on
`GR-005334|PO-009887` and they are each other's:

```
GR-005334|PO-009887 DtlKey 917594: AutoCount "AK-IMMORTAL MATT (K)"  vs ERP "AKEMI ULTIMATE MATT (K)"
GR-005334|PO-009887 DtlKey 917604: AutoCount "AK-ULTIMATE MATT (K)"  vs ERP "AKEMI IMMORTAL MATT (K)"
```

Read as stated, that says a customer's receipt names the wrong mattress. It does
not: the receipt holds both mattresses, and only the row order is unknown.

**Root cause (traced).** Two measurements against production, both re-run while
writing this:

* `backfill-ac-downstream-line-keys.mjs` dry run, **run `34199483652`** — the
  seven rows of `GR-005334|PO-009887` carry **no** AutoCount line key, and it
  says why it refused to stamp one: *"AKEMI IMMORTAL MATT (K): the book has 2
  lines of this item at this quantity and they are NOT identical (2 distinct
  price/location/Desc2 combinations), so which is which is unknowable"*. So the
  reconcile paired those rows by the (qty, unit price) fallback — a guess.
* `probe-gr-pi-iv-residue.mjs`, **run `34198777922`** — *"326 pairs where the
  book's item codes and ours are the SAME MULTISET; **0** where they genuinely
  DIFFER"*. The goods on that receipt are the book's goods.

`lib/ac-not-a-difference.mjs`'s `splitGuessedItemCodePairing` exists to move
exactly this row out of the difference column, and it did not, because clause
(a) read `b.keyed` — **whether ANY line of the DOCUMENT carried a key** — and
`GR-005334|PO-009887` has keyed lines beside the seven unkeyed ones. Worse than
counting it: `if (b.keyed) continue` skips the row before the impostor branch, so
it was not even printed with a reason.

That flag was correct while a document was all-keyed or all-keyless, which is
what production was until 2026-09-08 14:22 (+08): `scm.grn_items.linked_ac_dtlkey`
was NULL on all 636 rows. The backfill then stamped 563 and deliberately left
73 NULL, and a **partially keyed document became the normal state** — 29
receipts are in it. The document-level question stopped answering the line-level
one, silently.

**Fix.** `check-ac-erp-reconcile.mjs` now carries `erpKeyed: el.ac_dtlkey != null`
on each item-code row it hands over, and `splitGuessedItemCodePairing` reads the
row's own flag when it has one, falling back to the document flag for a caller
that does not carry it. Nothing else moved: an unkeyed row whose multisets DIFFER
is still an impostor and still counted — that half is pinned by its own new test,
because a per-line amnesty is exactly the shape that could swallow a wrong
product. `backend/tests/acNotADifference.test.ts` +3. Proved RED on the unfixed
line: 2 failed / 33 passed with `if (b.keyed) continue`, 35 passed with the fix
(`npx vitest run --config vitest.light.config.mts tests/acNotADifference.test.ts`).

**Ref.** fix/gr-iv-pi-remainder, 2026-09-08.

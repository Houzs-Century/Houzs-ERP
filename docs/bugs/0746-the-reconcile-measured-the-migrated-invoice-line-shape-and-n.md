## The reconcile measured the migrated invoice line shape and never told the verdict [medium]

**Symptom.** Nine sales invoices were reported to the owner as work — 「still
differ from the account book and somebody owes each one」 — on a run that had
already measured them as reconciled. `HC-I-001034`, `HC-I-2410-0082`,
`HC-I-2412-0353`, `HC-I-2412-0374`, `HC-I-2501-0378`, `HC-I-2501-0408`,
`HC-I-2504-0211`, `HC-I-2505-0362`, `HC-I-2506-0074`, all on run 34313148505
(SALES INVOICES NOT TALLIED — 16 of 49). Every one of the nine holds the book's
total to the sen, and every book line it does not carry is priced at RM 0.00.

**Root cause (traced).** `splitMigratedChainLineShape`
(`backend/scripts/lib/ac-not-a-difference.mjs`) has decided since 2026-09-08
which invoice line-count differences are the line SHAPE the migrated chain
produces by design — the invoice is built from OUR delivery order / goods
receipt, so the number of rows is ours and what must agree is the money. Its
answer reached the SUMMARY line and stopped there:
`check-ac-erp-reconcile.mjs` computed `LS` and only ever `log()`ed it. The one
call to `VERDICT.reclassify` in the whole file was `erp-zero-money`'s, at
`:1384`. So the per-document verdict — the thing the owner reads — went on
counting documents the run itself had cleared.

The second half was never split at all. The unpaired book line is recorded on
its own axis, `a book line we do not have` (`:1244`), and that axis is the SAME
shape seen from the other end: on a migrated invoice a book row we do not carry
is exactly why the row count differs. Measured on run 34313162057
(`probe-book-line-gaps`, read-only): for all nine, ERP `total_sen` equals the
book's `docTotalSen` exactly, and every unpaired book line is quantity 0 or
subtotal RM 0.00.

This is `docs/bugs/0715` with the arrow reversed. There, a comparison that never
ran was counted as a difference; here, a split that DID run was thrown away.

**Fix.** `splitMigratedChainLineShape` and the new
`splitMigratedChainUnpairedBookLine` now share ONE per-document verdict
(`migratedChainShapeVerdict`), so the two axes cannot answer differently about
the same document on the same run; the reconcile reclassifies both into the new
note class `migrated-chain-line-shape`, which carries its own sentence in
`DECLARED_LABEL` and is printed under 「WHAT THIS VERDICT EXCLUDED, AND UNDER
WHOSE RULING」 like every other declaration. Both gates are unchanged and are
what stops it being an amnesty: a document whose TOTAL moves, or that is short a
PRICED line, fails both and is reported LOUDER as an impostor; a document with
no measurement at all is UNPROVEN, never waved through.

Proved RED on the unfixed tree: `tests/acNotADifference.test.ts` — 6 failed,
`TypeError: splitMigratedChainUnpairedBookLine is not a function`. Green after,
50 passed. `tests/migratedChainShapeWiring.test.ts` is new and pins the wiring
itself, because the whole bug was a measurement that never reached the verdict.

**Ref.** fix/book-line-inserts, 2026-09-09.

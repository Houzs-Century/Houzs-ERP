## The item-code repair lane would have undone the owner's own model ruling [high]

**Symptom.** `correct-so-item-code-from-autocount.mjs` was dispatched read-only
against production with `POPULATION=all` (run 34258437955, 2026-09-08) to close
the last sales-order item-code difference. It planned **two** corrections. One of
them was HC-SO-011657, putting `8030-STOOL` back to the book's `TNS-9838 DB` —
the model **the owner chose himself** the same day with 「那就放8030 daybed把」.
Nothing in the plan said so; it read as an ordinary eleventh member of the class
the owner ruled on that morning. The run's own restorable dump names the row:

```
UPDATE scm.mfg_sales_order_items SET item_code = '8030-STOOL',
  item_group = 'sofa', description = 'SOFA SOFFIO STOOL'
  WHERE id = '8ff34b58-4cfd-48d1-8849-eeb6d4f690de';
```

**Root cause (traced).** `planSoItemCodeCorrections`
(`backend/scripts/lib/so-item-code-correction.mjs`) plans every line
`lib/item-code-class.mjs` calls `different`, and `different` is exactly what the
owner's decision looks like from there — the ERP names model 8030 where the book
names 9838, which is the definition of the defect class this lane exists to
correct. The declaration that says a person decided it
(`modelOverride` in `backend/scripts/data/sofa-compartment-corrections-2026-09.json`)
had two readers by 2026-09-08 — `lib/sofa-corrections-book-grade.mjs:123` and,
since `docs/bugs/0727-the-owner-s-own-model-decision-was-still-counted-as-a-differ.md`,
the reconcile's verdict — and this planner was not one of them.

It is a NEAR MISS, not damage: the plan was never applied, because the plan was
read. The population had also hidden it until this run — the default
`POPULATION=edges` only asks about lines AutoCount's own `PODTL` edge names, and
HC-SO-011657 has no purchase order at all, so the morning's apply could not have
reached it.

**Fix.** `planSoItemCodeCorrections` takes `overrideIndex` and refuses a row
carrying a complete declaration, counting it as `ownerDecided` and printing
whose decision it is. The rule is `lib/ac-model-override.mjs`'s `overrideCovers`,
asked and never restated, so this lane and the reconcile's verdict cannot
disagree about what he decided — and the declaration still expires by itself
when the book stops saying the model it overrides.

**The parameter is REQUIRED, not optional.** It decides whether a row is
written, and CLAUDE.md's rule is that such a parameter is never optional: an
omitted one throws rather than silently correcting everything. `null` is the
explicit way to say "no declaration loaded".

**Proved RED on the unfixed tree.** With the guard disabled,
`backend/tests/soItemCodeCorrection.test.mjs` failed 1 of 14 — the owner's
decision was planned as a correction. Restored: 14 passed. The expiry is pinned
in the same file: a declaration whose book model no longer matches does NOT
protect the row.

**Ref.** `diag/so-po-counter-causes`, 2026-09-08.

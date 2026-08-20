## Deleting a compartment row offered to RENAME it across all history [high]

**Symptom** — The owner deleted the sideless bench codes `1B` and `2B` from the
sofa compartment pool and, in the same save, added a new `DB` (Daybed). The
maintenance page answered with a red confirm: **"Rename compartment code? 1B ->
DB — This cascades EVERYWHERE: SKU codes + names, sales orders (incl. history),
delivery orders, invoices, GRN/PO lines, Modular ticks, Combos and Quick
Picks."** He had not renamed anything. One click would have rewritten every
historical `1B` into `DB`, and the cascade has no dry run.

**Root cause** — `Products.tsx` inferred renames by comparing the old and new
pool arrays **BY INDEX**. A rename is an in-place edit, so the row count cannot
change — but the detector never checked that. Deleting rows 29 (`1B`) and 30
(`2B`) slid the freshly-added row 31 (`DB`) up into index 28, so `baseline[28] =
"1B"`, `next[28] = "DB"`, `"1B"` was absent from the new list and `"DB"` from
the old — every condition for "this is a rename" satisfied by a delete plus an
add.

**Fix** — Only look for renames when `baseline.length === next.length`. A length
change is an add and/or a delete; the plain save already handles it.

**Also shipped** — `fix-sofa-compartment-pool.mjs` + workflow, so the removal
can be done on its own (append-only new config row, dry-run default) and refuses
to drop a code any SKU or document line still uses. Sideless `1B`/`2B` are
leftovers from before the owner's ruling that a bench always carries a side
("1B 都是要 direction 的啊,扶手在哪里"); the decoder has always EMITTED
`1B(LHF)`/`1B(RHF)` and never a bare `1B`, so nothing depends on them.

**The class, for next time** — a positional diff cannot tell an edit from an
insert. Anything that infers "this row was renamed" needs row identity, or at
minimum a length guard, before it is allowed to touch history.

**Ref** — 2026-08-10, PR fix/sofa-pool-sideless-bench.

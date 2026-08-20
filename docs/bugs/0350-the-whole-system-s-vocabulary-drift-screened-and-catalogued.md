## The whole system's vocabulary drift, screened and catalogued; the SO guide still claimed a retired column was written [medium]

**Symptom.** Owner, 2026-08-18: read the whole system once, find every place the
same thing has more than one spelling and every place the docs disagree with the
code, and put something in place so it never has to be done by hand again.

**Root cause / findings (a 12-agent full-codebase read, 1,360 source files,
2.8M tokens).** 33 concepts carry more than one genuine spelling — money
(`_centi`/`_sen`/`_cents`), salesperson (`salesperson_id`/`agent`/`sales_reps`),
customer vs debtor, supplier vs creditor, item vs material vs product code,
warehouse vs sales_location, the delivery date under five names, and more. 21
defects surfaced in passing (0 high; a tenant-predicate gap on PUT
delivery-orders crew, a DP-number mint that swallows a read error, a DO
cancelled-detection that only matches "T", and others). One doc-drift:
`docs/modules/sales-order.md` line 101 and line 1207 still said the
`IN_PRODUCTION` transition and POS "Proceed" stamp `proceeded_at`, a column
neither written nor read since #2396 / mig 0286 — the guide even contradicted
itself, correcting the claim at line 1316.

**Fix (batch 1 — stop the bleeding, this PR).**
- The full report is saved as `docs/system-screening-2026-08-18.md`, the batch-2 worklist.
- `drift-catalogue.mjs` holds the 33 concepts as REFERENCE data; the generated
  `docs/generated/GLOSSARY.md` now prints a "say this / also seen as" row per
  concept, so anyone can look up the agreed word. Nothing is retired here —
  retiring a live column is a migration, one concept per PR (batch 2) — so the
  guard's contract is unchanged and stays honest.
- The two stale `sales-order.md` claims are corrected.
- `docs/VOCABULARY-UNIFICATION-PROGRESS.md` tracks the programme's stages and worktrees.

**Money is a display rule, not a storage change.** Exports read `35.00` by
formatting the stored integer as RM at the edge; storage stays an integer minor
unit because decimals reintroduce the float-rounding bugs `money.ts` exists to
prevent. Batch 2 unifies the NAME, not the type.

**Ref.** 2026-08-18, branch `feat/one-vocabulary`.

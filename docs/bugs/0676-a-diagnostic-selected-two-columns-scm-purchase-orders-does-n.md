## a diagnostic selected two columns scm.purchase_orders does not have, and died on its first production run [low]

**Symptom.** The first production dispatch of the new purchase-invoice
diagnostic, run 34139235936 (2026-09-07 23:37 +08), failed outright:

```
PostgresError: column "exchange_rate" does not exist
  code: '42703'
  at scripts/diag-migrated-purchase-invoices.mjs:94
```

**Root cause (traced).** The purchase-order read asked for `currency,
exchange_rate`. `scm.grns` carries both — `create-migrated-invoices.mjs` reads
them there and always has — and the pair was carried across to the
purchase-order query out of habit. `scm.purchase_orders` has neither, and the
script never used either value: the currency verdict comes from the AutoCount
header, which is where a document's own currency actually lives
(`ac-scope.mjs`'s `currencyVerdict`).

**Fix.** Both columns dropped from the SELECT. Re-dispatched as run 34139368829
and completed successfully, printing all 21 attributions.

**The rule it is a datapoint for, which is already in CLAUDE.md.** *"A
`workflow_dispatch` workflow is not shipped until it has been dispatched once and
reported success."* This one was written, typechecked, smoke-run locally against
an unreachable DSN — which proved every import, the snapshot decode and the scope
build, and could not possibly prove a column name — merged, and only then run.
The local smoke test reached the first query and stopped there, which is exactly
the shape that feels like verification and is not: it proved the code loads, not
that the schema agrees.

**Ref.** fix/ac-purchase-invoices, 2026-09-07.

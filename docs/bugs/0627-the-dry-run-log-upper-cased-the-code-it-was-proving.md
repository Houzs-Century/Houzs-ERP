## The dry-run log upper-cased the code it was proving [low]

**Symptom.** `docs/bugs/0626-…` fixed `redecode-collapsed-sofa-lines.mjs` so a
decoded piece is written in the product master's own spelling (`8038-Console`,
not `8038-CONSOLE`). The very next production dry-run — run 33665828878,
2026-09-02, with the fix on `main` — printed:

```
  HC-SO-012695  [8038]  1A(P)(LHF)+CONSOLE+1A(P)(RHF)
        insert   CONSOLE   (every money column 0)
```

Identical to the run that had the bug. Anyone reading that output as the
evidence for the fix would reasonably conclude the fix had not landed.

**Root cause (traced).** Nothing was wrong with the write. The PLAN PRINTER
called `compartmentOf()`, which upper-cases by design because its other job is
comparison. So the log rendered the correct value and the incorrect value as the
same string — the check that answers a different question, this time about its
own output. Confirmed at the unit level: `compartmentOf('8038-Console')` is
`'CONSOLE'` while the plan itself carried `8038-Console`.

**Fix.** The plan prints the item code VERBATIM, exactly as it will be written.
`compartmentOfVerbatim()` is added for the one WRITTEN value that also needed the
suffix — `purchase_order_items.supplier_sku`, which the PO importer composes as
`<AutoCount item code> <compartment>` and which had the same upper-casing.
`compartmentOf()` keeps its upper-casing and its header now says it is for
comparison only. Pinned by a test asserting the two spellings differ.

**Ref.** `fix/redecode-dryrun-log-verbatim`, 2026-09-02. Runs 33664350222 (the
defect) and 33665828878 (the log that could not tell).

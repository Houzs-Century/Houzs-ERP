## The first sales order after the write-back went live was refused, and the documented remedy could not be applied [high]

**Symptom** - `scm.autocount_writeback` was switched to `"1"` on 2026-08-13 and
the first real order saved, `HC-SO-2608-001`, never reached AutoCount. It was
not lost: the outbox held one row, status `skipped`, reason

```
refused, nothing sent (ItemCodeError): 1 line(s) have no single AutoCount
ItemCode: line 1 - ERP item code '9028-1S' maps to 2 AutoCount items and the
document names no supplier to choose between them
```

**Root cause** - the refusal itself is correct and by design (D10: `9028-1S` is
`AMN-SF9028 SOFA` under supplier 400-A004 and `DSL-9028 SOFA` under 400-D004,
and a sales order names no creditor to choose between them). The defect is that
its documented escape hatch was unreachable. `resolveAcItemCode` checks
`opts.bindings` FIRST and returns immediately on a hit, so a
`scm.supplier_material_bindings` row is supposed to settle any ambiguity. But
`bindingsFor` was called with the RAW line codes -
`lines.map((l) => l.item_code)` at `autocount-outbox.ts:514` runs before D9 -
while the resolver runs AFTER D9, on a collapsed line whose `item_code` is a
SYNTHESISED `<model>-1S` (`autocount-sofa-collapse.ts:356`). So the query asked
for `9028-1A(LHF)` and `9028-2A(RHF)` and the lookup asked for `9028-1S`. The
two never met, and no binding row for a sofa model was ever fetched.

Consequence: the four sofa models whose ERP code is ambiguous in the cutover map
- 9028, 9058, 5152, 5080 - refused every sales order containing them, and no
amount of data entry could fix it. Measured: 117 of 1427 ERP codes in the map
are ambiguous; the other 113 are non-sofa, where the binding path did work.

**Fix** - `bindingsFor` expands its query with each line's sofa base code
(`splitSofaCode(code)` -> `<model>-1S`), so the map contains the key the
resolver will actually ask for. A no-op for non-sofa lines, where
`splitSofaCode` returns null. Regression test asserts the refusal without a
binding AND the successful send with one; it fails on the pre-fix tree.

**Lesson** - **when a pipeline rewrites its own keys, every lookup keyed off
them has to be built from the same stage.** The binding map was assembled from
pre-collapse codes and consumed post-collapse, one function apart, and both
halves read correctly in isolation. Nothing failed loudly: the outbox row said
`ItemCodeError`, which is a true statement about the collapsed code and gives no
hint that the override never had a chance to fire. The health check made it
worse by printing "line identity missing - backfill linked_ac_dtlkey" for it,
because it matched on the shared `refused, nothing sent` prefix that all four
refusal classes produce - fixed in the same batch.

**Ref** - `fix/sofa-binding-lookup` + `fix/outbox-health-skip-detail`, 2026-08-13

---

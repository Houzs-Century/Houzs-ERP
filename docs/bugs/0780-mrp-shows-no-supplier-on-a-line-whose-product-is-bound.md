## MRP shows no supplier on a line whose product IS bound [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** The owner, 2026-09-10, with the plan screen open. On
`HC-SO-013497` all four pieces are 9058 with the same fabric, and the supplier
column disagrees line by line:

```
9058-L(LHF)  · HR805-90 / SEAT 30 / SPECIAL: ...  -> HOOKKA INDUSTRIES
9058-1NA     · HR805-90 / SEAT 30                 -> — none —
9058-1NA     · HR805-90 / SEAT 30                 -> — none —
9058-1A(RHF) · HR805-90 / SEAT 30                 -> HOOKKA INDUSTRIES
```

His own screens prove the data is there: the supplier page lists `9058-1NA`
bound to HOOKKA INDUSTRIES with supplier SKU `5536-1NA`, and the purchase-order
picker resolves a bound SKU to its supplier and says *"264 item(s) bound to this
supplier"*. 「这不就是说这个 item 有什么 Supplier 吗？」

**Consequence, and why this is high:** a `— none —` row cannot be turned into a
purchase order from the plan. The buyer has to leave the page and raise it by
hand, or the line waits.

**Status: NOT DIAGNOSED. This entry ships the check, not a fix.**

**Two causes are RULED OUT, with evidence, so nobody re-chases them:**

- **Not missing or mis-typed bindings.** `check-supplier-binding-visibility.mjs`,
  run **34447806315**: 17 `9058-*` products, **71 binding rows**, all
  `material_kind = 'mfg_product'`, all `company_id = 1`, exactly one main
  supplier per piece, and no binding pointing at a deleted supplier. Both
  readers — the shared one and the product page — would return all 71. The
  hypothesis that the two readers' predicates differ was REFUTED by that run.
- **Not the ~1000-row PostgREST cap** that produced this exact symptom on
  2026-08-16 (2,660 rows against the cap). That fix went into
  `backend/src/scm/lib/supplier-bindings.ts`, so MRP's supplier read is chunked
  and paged today.

**The remaining hypothesis, and what would refute it.** MRP fills its map with
`suppliersByCode.get(d.item_code)` (`routes/mrp.ts:1513` for a sofa set,
`:1351` for the general path) — the demand row's own `item_code` STRING against
the binding's `item_code` STRING, an exact match. A line differing by case, by a
trailing space, or by any invisible character finds nothing, while the product
page and the PO picker, which reach the product by ID, show everything.

The catalogue is already known to hold case-twins: the same probe found
**`9058-Console` AND `9058-CONSOLE`** — two products, one description
(SOFA MAYBATCH CONSOLE), different main suppliers.

**REFUTED IF** every line of `HC-SO-013497` matches a binding on its exact
string. Then the fault is downstream — in the response, or in the sofa SET
grouping, which takes its supplier list from the first set in the group
(`frontend/src/pages/scm-v2/Mrp.tsx:282`).

**Fix.** None yet. `backend/scripts/check-so-line-supplier-lookup.mjs` plus the
**SO line supplier lookup (read-only)** workflow print each line's `item_code`
as stored — length and any non-ASCII byte included — beside the binding count on
that exact string and on the case-folded, trimmed form. The script states both
verdicts in words, so a refutation reads as clearly as a confirmation.
**UNTESTED against production as of this commit.**

**Ref.** fix/mrp-supplier-none, 2026-09-10.

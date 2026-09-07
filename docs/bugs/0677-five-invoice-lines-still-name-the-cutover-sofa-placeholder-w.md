## Five invoice lines still name the cutover sofa placeholder while their source line names the real compartment [high]

**Symptom.** Nobody saw it. `probe-link-identity.mjs` counted 2 of 182 linked
sales-invoice lines and 3 of 198 linked purchase-invoice lines whose link "points
at a line for a different product" (runs **34137796488** and **34139187692**,
2026-09-07 23:22 and 23:37 local, both `success`). `docs/bugs/0676` recorded the
count and marked the cause UNKNOWN rather than naming a route on the strength of
it being a route that COULD have done it.

**What they actually are — PROVEN, `probe-invoice-link-facts.mjs`, run
34143079454, 2026-09-08 00:26 local, `success`:**

| invoice | invoice line says | it points at | source doc lines | header names it |
|---|---|---|---|---|
| `HC-I-000745` [SENT] | `5526-1S` | `HC-DO-000542` `5526-L(LHF)` | 1 | yes |
| `HC-I-2412-0065` [SENT] | `2379-1S` | `HC-DO-002158` `2379-2S` | 1 | yes |
| `HC-PI-007551` [POSTED] | `9058-1S` | `HC-GR-005068` `9058-1A(LHF)` | 1 | yes |
| `HC-PI-007917` [POSTED] | `9058-1S` | `HC-GR-005306` `9058-1A(LHF)` | 1 | yes |
| `HC-PI-007920` [POSTED] | `8030-1S` | `HC-GR-005277` `8030-1A(LHF)` | 1 | yes |

**The link is NOT wrong.** Every source document carries exactly ONE line, and
the invoice header names that same document. There is nothing to re-point to.
What disagrees is the item CODE, and the invoice side is always `{model}-1S`.

**Root cause (traced).** `{model}-1S` is the cutover binding's PLACEHOLDER, and
this repo says so in its own words —
`backend/scripts/lib/sofa-piece-fold.mjs`: *"The binding CSV maps every AutoCount
sofa item to the model's `-1S` compartment ... all 86 SOFA-category rows end in
`-1S`."* Checked against the committed binding for all four models
(`backend/scripts/data/autocount-erp-mapping-1561.csv`, 82 SOFA-category
placeholder codes on this tree):

```
AMN-SF9058 SOFA -> 9058-1S     DSL-8030 SOFA -> 8030-1S
DSL-9058 SOFA   -> 9058-1S     THL-2379      -> 2379-1S
RDS-5526 SOFA   -> 5526-1S
```

AutoCount holds ONE line per sofa; the ERP holds one line per COMPARTMENT
(`src/services/autocount-sofa-collapse.ts`). A migrated line lands on the
placeholder and is decomposed later. **These five invoice lines were never
decomposed while the delivery / receipt line they were raised from was.**

**The money consequence is NONE, and that is checked rather than asserted.** The
link is correct, so `invoiced` (`lib/do-line-remaining.ts`) is still summed onto
the right delivery line and `recost.ts` still aggregates onto the right receipt
line. `qty`, `unit_price_sen`, `line_total_sen` and the link column are re-read
on a FRESH connection after the write and must come back byte identical; only
`item_code` moves. What was wrong is what the document NAMES — a customer
invoice reading `5526-1S` (a single seat) for a `5526-L(LHF)` chaise.

**Fix — two halves.**

1. **The rows.** `backend/scripts/repair-invoice-source-item-code.mjs` COPIES the
   compartment code off the source line. It decodes nothing and chooses nothing,
   and refuses everything not FORCED: the code must be a placeholder the binding
   actually maps a sofa onto (a bare `-1S` can be a genuine single-seat line),
   the source must be the same model, the source document must carry exactly one
   line, and the invoice header must name it. The `UPDATE` carries a predicate on
   the OLD code — `docs/bugs/0672` site 5 is a script that wrote
   `SET item_code = ? WHERE so_item_id = ?` with no such predicate, the inverted
   form of this same class. Decision pure and unit-tested:
   `scripts/lib/invoice-sofa-placeholder-repair.mjs`,
   `tests/invoiceSofaPlaceholderRepair.test.mjs` (11 assertions, the five real
   rows asserted as data).

2. **The cause, so a repair is not needed twice.**
   `src/scm/lib/invoice-source-item-identity.ts` refuses a bind whose two lines
   name a different product, at all SIX write paths on the two chains — create,
   add-line and line-PATCH on each. It takes its OWN company-scoped read
   (`checkSiReopenOverRemaining` already bought the lesson that a guard whose
   inputs are assembled elsewhere can be starved) and FAILS CLOSED with 503.
   The PATCH arms check the EFFECTIVE POST-PATCH code: `unlinkedEditRefusal`
   beside them is scoped to a STORED link of `null`, so a line already carrying a
   link could have its product rewritten under it.

**Proved RED first.** `tests/invoiceSourceGuardCallSites.test.mjs` pins the rule
at each call site. Before the guard was wired, on the tree carrying only the
module and its behavioural test:

```
 Test Files  1 failed (1)
      Tests  8 failed (8)
```

After wiring: `Test Files 1 passed (1) / Tests 8 passed (8)`. The behavioural
half is `tests/invoiceSourceItemIdentity.test.ts`, 14 assertions.

**UNTESTED as a remedy at the time of writing:** the repair workflow has not been
dispatched. It cannot be until it is on `main` — `workflow_dispatch` only exposes
workflows from the default branch. The guard is a refusal: it makes a FUTURE
write fail, and it neither undoes an existing wrong code nor proves one absent.

**Ref.** fix/invoice-link-identity, 2026-09-08.

## Two readers of the same supplier bindings carry different predicates [medium]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** The owner, 2026-09-10, on sofa model 9058: the Product page lists
its bound suppliers and the plan screen shows none, so the buyer cannot raise a
purchase order from a SKU that demonstrably has suppliers.

**Status: NOT DIAGNOSED. This entry ships the check, not a fix.** Saying which
of the two screens is wrong decides whether this is a data repair or a code
change, and nothing in the tree settles it — the answer lives in production.

**The hypothesis, and what would refute it.** The two readers do not carry the
same predicates:

| reader | filters |
| --- | --- |
| `backend/src/scm/lib/supplier-bindings.ts` — used by MRP, the PO picker, `so-revision`, the AutoCount outbox | `material_kind = 'mfg_product'` **and** `company_id` |
| `backend/src/scm/routes/mfg-products.ts` `GET /:id/suppliers` (the Product page) | `company_id` only |

So a binding row whose `material_kind` is anything else — or NULL — is VISIBLE
on the Product page and INVISIBLE everywhere a purchase order is raised, which
is exactly the shape of the symptom. **REFUTED IF** every binding row for 9058
already reads `material_kind = 'mfg_product'`; then the two readers return the
same set and the cause is elsewhere.

Two other readings are printed alongside so they can be told apart rather than
assumed: the bindings sitting on the MODEL code while demand and purchase orders
carry the PIECE codes, and a binding whose supplier row has been deleted — MRP
skips those silently (`orphaned binding — skip`), which also reads as "no
supplier" on that screen.

**Ruled out already, from the tree.** Not the ~1000-row PostgREST cap that
produced the identical symptom on 2026-08-16. That fix went into the shared
reader, so MRP's supplier read is paged and chunked today; and the two readers
that still query `supplier_material_bindings` directly
(`routes/mfg-products.ts`, `lib/po-pricing.ts`) are each bounded to ONE item
code, so neither can be clipped.

**Fix.** None yet — deliberately. `backend/scripts/check-supplier-binding-visibility.mjs`
plus the **Supplier binding visibility (read-only)** workflow ask the database
the same question in both shapes and print where they diverge, so the next
person answers this with a dispatch instead of a guess. SELECTs only; exits 0
for every legitimate answer including "no rows", because a red job would read as
"the check broke" and the ANSWER is the output. **UNTESTED against production as
of this commit** — the workflow has not been dispatched yet.

**Ref.** chore/supplier-binding-probe, 2026-09-10.

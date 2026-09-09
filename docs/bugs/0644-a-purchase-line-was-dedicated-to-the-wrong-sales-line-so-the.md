## A purchase line was dedicated to the wrong sales line, so the sofa correction could not finish [high]

**Symptom.** `HC-SO-012929` could not be finished. The owner ruled its 26" build
is `1A(LHF)+2A(RHF)`; the purchase order `HC-PO-009751` was corrected to exactly
that, and the sales order still carried a surplus `9028-1S` at 26" holding the
whole build's price (RM 6,680). Every run of
`apply-sofa-compartment-corrections.mjs` refused it — correctly — with:

```
HC-SO-012929: REFUSED — a surplus line is referenced downstream: 9028-1S: 1 PO line(s), 0 DO line(s)
```

**Root cause (traced).** `scm.purchase_order_items.so_item_id` is the
DEDICATION: this purchase line was raised for THAT sales line. On
`HC-PO-009751` the `9028-1A(LHF)` line pointed at the sales order's `9028-1S`,
and the `9028-2A(RHF)` line pointed at nothing. So the surplus placeholder the
correction wants to remove had a purchase line hanging off it, and the
correction's own guard (`apply-sofa-compartment-corrections.mjs`, the `blockers`
check on a surplus row) refused the whole build rather than cut a referenced
line.

That state is a defect against a rule this codebase already states, not a
preference: `soLinkTargetRefusal` in `backend/src/scm/routes/mfg-purchase-orders.ts`
answers 409 `so_link_material_mismatch` to any bind whose two codes differ,
because "binding a PO line for one SKU to an SO line for another makes every
downstream reader lie". No operator could have created it through the UI — it
came in with the AutoCount migration, which stamped the dedication from the
AutoCount line order rather than from the item code.

Measured on prod (company 1, read-only role, 2026-09-05): across the WHOLE
company exactly **one** purchase line disagreed with the sales line it named,
and it was that one. `scm.purchase_order_item_allocations` was empty for the
pair, `scm.inventory_movements` named neither document, and the only goods
receipt involved (`HC-GR-005229`) is `migrated_no_stock = true` — so nothing had
moved real stock under the wrong pointer.

**Fix.** `backend/scripts/repair-po-so-item-dedication.mjs` re-points a named
(sales order, purchase order) pair's dedications onto the sales line carrying
the same item code AND seat depth — matched by code, never by position, which is
what put a 28" single seater at risk on this very document. It writes ONE column
and nothing else: no code, no price, no quantity, no row added or removed, and
both money columns on both documents are summed before and asserted again on the
fresh connection after. Removing the freed placeholder stays
`apply-sofa-compartment-corrections.mjs`'s job, under its own guards.

The planner is pure and lives in
`backend/scripts/lib/po-so-dedication-plan.mjs`; `po-so-dedication-plan.test.mjs`
pins it with the real prod ids and was proved RED on the unfixed tree
(`ERR_MODULE_NOT_FOUND`, then 13/14 with the last refusal wording wrong, then
14/14). It refuses rather than picks in every case where the answer is not
forced: two candidate sales lines, none, a pointer that leaves the document
pair, a cancelled target, a quantity that would exceed the demand, or a purchase
order with no dedication to this sales order at all.

`po_qty_picked` is deliberately NOT recomputed. It is derived
(`recomputeSoPicked`), the migrated corpus never rolled it — every line of this
pair reads 0 — and rolling it here would make one sales order differ from every
other migrated one for a reason that has nothing to do with the pointer. The
verification asserts it did not change.

**Ref.** `fix/po-so-dedication`, 2026-09-05.

## convert-from-SO trusted the caller's item_group while create and add-item resolved it from the SKU [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Owner, 2026-09-11, on the MRP page: *"SO-013389 this already have
PO-010087, please update it"*. `HC-PO-010087` is open, unreceived, and linked to
the right sales-order line — and MRP still reported that line SHORT, so the buyer
was being told to order a sofa that was already on order.

**Root cause (traced).** That purchase-order line carries `item_group = 'others'`
while its sales-order line carries `sofa` and the SKU master says `SOFA`
(`8030-1A(LHF)`, verified on production, read-only). `item_group` is not
cosmetic: it composes the variant key AND it is what `isHardBoundLine`
(`scm/lib/so-stock-allocation.ts`) reads, so a company-1 sofa line on `others` is
not "dedicated" — `isDedicated` in `scm/routes/mrp.ts` requires `so_item_id` AND
a hard-bound group, and section 8's `boundSofa` walk then reads
`dedicatedOpenByLine` and nothing else. Fail either half and the purchase order
is invisible to the set.

**Three of the four paths that write a PO line already resolved the group from
the SKU master; convert did not.** `create` (line ~1259) and `add-item` (line
~3059) both run `lineIdentityFields(skuCategoryResolver(…))` — the rule
`docs/bugs/0514` installed. `poConvertLineRow` copied `l.itemGroup` straight from
whatever reached the route, so the same sofa could land as `sofa` through one
door and `others` through another.

**What is PROVEN and what is not, stated apart.** PROVEN: the three-way
disagreement on that row, and that convert is the one write path without the SKU
rule. **UNKNOWN: which route actually wrote that row.** The line was created with
its purchase order on 2026-08-29, after the SKU rule shipped (2026-08-22) and
with the SKU already catalogued as SOFA, so it is consistent with the convert
path and not established as it. This fix closes the hole regardless of which door
was used; it is not offered as the traced provenance of that one row.

**Fix.** `poConvertLineRow` takes the resolved group as a **required** fourth
parameter and stores it for both `item_group` and `description2`, so the two
cannot drift (the drift `docs/bugs/0514` records). Required rather than
defaulted, for the same reason `fromMrp` is required in that file: a decision
that changes the stored row must fail to COMPILE when a new caller forgets it,
never fall back to one arm's answer (BUG CLASS optional-param-noop). Both convert
arms — append-to-existing and create-per-supplier-bucket — now build a
`skuCategoryResolver` over their own lines and pass `groupOf(line)`; the resolver
already falls back to the line's own group when the SKU is not catalogued, so an
uncatalogued code behaves exactly as before.

**Proved RED on the unfixed tree.** Reverting the two lines to `l.itemGroup` and
re-running `po-convert-line.test.ts` fails both new tests with
`AssertionError: expected 'others' to be 'sofa'`. With the fix: 8 passed.
The required parameter also made the compiler enumerate every call site — the two
routes and eight test call sites — which is the enumeration this change relies on
rather than a grep.

**Ref.** `fix/po-line-link-guards`, 2026-09-11. Related: `docs/bugs/0808`
(the missing `so_item_id` half of the same symptom) and the repair that fixed the
three live rows, `backend/scripts/repair-mrp-po-line-links.mjs`.

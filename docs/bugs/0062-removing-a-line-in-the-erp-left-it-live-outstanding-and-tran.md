## Removing a line in the ERP left it live, outstanding and transferable in the AutoCount book [high]

**Symptom** - the owner widened the go-live gate to "SO DO SI PO GR PI, on create,
edit AND deleting an SKU". Delete was the one verb with no implementation at all.
A second, live-today variant: production has held two `cancelled = true`
sales-order lines since 2026-08-10 (PR #1937), and the next edit of either
document would have pushed them to AutoCount as ordinary lines at full quantity.

**Root cause (traced, not guessed)** - `/edit` applies only the lines it is GIVEN
(`AcSyncService.cs`, its `Lines` loop is a `foreach` over the payload). An edit is
composed from the document AS IT IS NOW, so a hard-deleted row is simply absent -
and absence is not an instruction. AutoCount kept the line, kept it outstanding
under `Qty - TransferedQty > 0`, and kept it transferable into a later DO or GRN.
The service half had been complete since it was written (`Retire: true` ->
`Qty = 0`, `Transferable = false`, an `[ERP-CANCELLED]` Desc2 marker), and
nothing in the ERP ever sent it. The cancelled-line half had the mirror cause:
`SO_ITEM_COLS` did not select `cancelled`, so `soLine` could not see it and
`composeEdit` had no way to tell a written-off line from a live one.

**Fix** - `retiredLineOf(sb, table, itemId)` reads the row's `linked_ac_dtlkey`
**before** the DELETE destroys it, and all six line-DELETE handlers hand it to
their edit as `retire`. `composeEdit` emits `Retire: true` for those and for any
retained line with `cancelled = true`, carrying only what identifies the line
(`DtlKey`, `ItemCode`, `Desc2` when present) because the service's Retire branch
`continue`s before it reads `Qty`. A cancelled line with no key is REFUSED, not
dropped - a retirement we cannot name is a silent divergence. Retirements are
appended last and deduplicated against the retained lines, so a re-added line
that inherited the key is edited rather than zeroed. `composeCreateSo` /
`composeCreatePo` drop cancelled lines entirely: on a create AutoCount holds
nothing to retire. **Still not done, and deliberately** - the ERP-side soft
cancel. Five of the six line tables have no `cancelled` column and all six routes
still hard-delete; converting them needs their readers taught first, and a
half-converted soft cancel is worse than the hard delete
(`docs/autocount-line-retirement-plan.md`).

**Ref** - feat/writeback-all-six, 2026-08-11.

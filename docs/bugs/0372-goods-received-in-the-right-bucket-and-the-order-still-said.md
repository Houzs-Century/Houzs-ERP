## Goods received, in the right bucket, and the order still said PENDING — the line had no warehouse [high]

**Symptom.** Owner, 2026-08-18, on `2990-SO-2607-028`: *"GRN done, received 2
carton. PO correct, GRN correct, look like system did not capture the data 2A."*
The sofa's `LOTTI-2A(RHF)` module read **PENDING** with a blank *Incoming PO*,
while its `LOTTI-L(LHF)` sibling read READY against `2990-PO-2607-023`.

**Everything upstream was correct.** PO both lines `received_qty = 1`; GRN
`2990-GRN-2608-006` both lines received, accepted and POSTED; the inventory lot
for the 2A sat in KL with `qty_remaining = 1`, batch `2990-PO-2607-023`, under a
variant key identical to the SO line's
(`fabriccode=cg-001|seatheight=30|legheight=2"`). The goods were in the right
bucket. The QTY 0 on the GRN panel is outstanding qty, not received qty.

**Root cause (traced, not guessed).** The SO line carried
`warehouse_id = NULL`, its sibling KL. Stock allocation buckets by
**(warehouse, item, variant)**, so a NULL-warehouse line matches no bucket: it
can never be allocated, never gets `allocated_batch_no`, and therefore never
leaves PENDING or shows an incoming PO. Nothing is logged — the line simply
never appears in any bucket the allocator walks.

**Scale, measured rather than assumed.** 18 non-service lines since 2026-06-01
carry a NULL warehouse; every one is PENDING and none has ever been delivered.
They are not one bug:

| | lines | why |
|---|---|---|
| script defect | 7 | `apply-sofa-compartment-corrections.mjs` |
| no address on the order | 10 | header `customer_state`, `sales_location` and `city` all blank, so nothing can derive a warehouse |
| still unexplained | 1 | `2990-SO-2607-028`, the reported one |

**The script defect, which this PR fixes.** The script inserts a missing
compartment on both sides of a build. Its `purchase_order_items` branch lists
`warehouse_id` and selects `i.warehouse_id`; its `mfg_sales_order_items` branch
omitted the column entirely. One run on 2026-08-11 09:08:33 — a single
statement, identical to the microsecond across six orders, with no audit rows,
which is how a direct-DB script is distinguishable from a route — produced
seven NULL-warehouse lines.

**The one still open.** `2990-SO-2607-028`'s 2A was inserted 229 ms before an
`UPDATE_LINE` audit row showing an operator changing the build to
`L(LHF)+2A(RHF)`, i.e. by the sofa re-split inside the line update. That path's
`baseRow` DOES carry `warehouse_id: it.warehouseId ?? defaultWarehouseId`, so
both were null at that moment and it is not yet proven why. Not claimed as
fixed.

**Repair.** All 8 lines whose order carries exactly one sibling warehouse were
set from that sibling — evidence, not a state→warehouse guess — and audited with
`source='repair'`. The 10 lines whose orders have no address anywhere were NOT
guessed: a venue ("2990s PJ") is a showroom, not a warehouse. They need a human
to assign one.

**The test is structural, because a value test cannot see this.** The SQL is a
template string and the bug is a missing COLUMN NAME, so every assertion about
the values that ARE there passes. `backend/tests/sofaCorrectionsWarehouse.test.ts`
asserts both INSERTs name `warehouse_id` and select `i.warehouse_id`, on
comment-stripped source, and is proven to fail when the column is removed.

**Ref.** PR (branch `fix/sofa-corrections-so-warehouse`), 2026-08-18.

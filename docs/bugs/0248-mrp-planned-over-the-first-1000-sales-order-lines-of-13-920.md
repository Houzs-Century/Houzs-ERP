## MRP planned over the first 1000 sales-order lines of 13,920, so a new SO was invisible [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Owner 2026-08-16: a brand-new sales order did not appear on the MRP
page at all and therefore could not be converted to a purchase order. Nothing
errored — the page rendered a complete-looking plan.

**Root cause (traced).** routes/mrp.ts read demand with `.limit(MRP_LOAD_CAP)`
where `MRP_LOAD_CAP = 5000`. PostgREST caps a response at `max-rows` (1000 here)
and `.limit()` does not lift it: the server returns ≤1000 rows and drops the rest
with no error and no signal. Prod matched **13,920** demand rows, so the plan ran
on the first ~1000 by `id` ASC — a uuid order, i.e. arbitrary. The owner's line
ranked **10,687th** (`probe-mrp-read-caps`, run 31937195713). Three more reads had
the same shape: `inventory_balances` (1,065 rows — missing balances become phantom
shortage), `mfg_products` (2,293), `supplier_material_bindings` (2,660 — a SKU
whose binding fell past the cap showed no supplier, so staff could not raise its
PO). `supplier_material_bindings` also passed the whole demand code list as one
unbounded `.in()`.

**AND THE GUARD COULD NEVER FIRE.** The read was followed by
`if (rows.length >= MRP_LOAD_CAP) throw 'mrp_load_truncated'` — 1000 >= 5000 is
false, so the check named after truncation could not detect truncation, and
`probe-mrp-guard-fires` (run 31938808637) confirmed every read AFTER the throw had
executed, i.e. it had never fired in two months of statistics. Two unit tests
certified it, and they passed because the FAKE honoured `.limit(5000)` literally
while the server does not. A gate that cannot fail is worse than none: it reads as
protection.

**Fix.** Every multi-row read on the page goes through lib/paginate-all
(`paginateAll` / `chunkIn`), each under a TOTAL order so `.range()` windows are
coherent (`inventory_balances` is a view with no id, so it orders by its full
group-by tuple). The cap and the guard are deleted rather than re-tuned — a bigger
`.limit()` is the same bug with a bigger wrong number. The test fake now enforces
the real 1000-row ceiling, so a fixture larger than the cap can only be read by
code that pages.

**The downstream call paging forced open.** `soDeliverableRemaining` puts its
argument straight into `.in('doc_no', …)` and the resulting line ids into
`.in('so_item_id', …)`. Paging demand takes it from ~700 docs to ~2,800 docs /
~13,900 uuids — a ~500KB request line, i.e. a 414 rather than a query, which would
have taken MRP from wrong to broken. MRP now calls it in batches of 200 docs and
merges the (disjoint, so_item_id-keyed) result maps. Batched at the CALLER on
purpose: every other caller passes a handful of docs, so the scale problem is
MRP's, and 200 docs reproduces the ~1000-line-per-call shape this path has always
run against instead of imposing an untested one on the DO picker and convert flow.

**Ref.** fix/mrp-paging-and-strict-variants, 2026-08-16.

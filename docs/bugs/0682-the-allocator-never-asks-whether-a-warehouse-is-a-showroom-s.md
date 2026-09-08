## The allocator never asks whether a warehouse is a showroom, so display stock is sellable [medium]

**Status: OPEN — measured, NOT fixed.** The remedy is a business rule the owner
has not ruled on yet, and it is deliberately not implemented here. This entry
records the finding and the instrument; it claims no fix.

**Symptom.** The 2026-09-08 cutover brought the book's 26 showroom display sofas
into the ERP exactly as AutoCount holds them — 24 at the warehouse the ERP calls
`BALAKONG DISPLAY` (the owner calls it KL) and 2 at `PENANG DISPLAY` (PG). They
carry no flag and no marking of any kind, because the owner refused one:
「你换不一样就代表我们的数据从 autocount 搬过来的就不一样了啊」 — a flag on a
migrated row IS a change to the data. Complete data, our rules on top.

That is the right call, and it leaves a question nobody had asked: a showroom
piece is not sellable, so what in the RULE layer stops one being sold? Nothing
in the import can answer that, and 「a missing grep hit is not proof」 — so it
was measured.

**Root cause (traced, by opening the files).** `so-stock-allocation.ts` step 6
pulls on-hand with

```
.from('inventory_balances')
.select('warehouse_id, item_code, variant_key, qty')
.in('item_code', batch)
```

— **no warehouse predicate of any kind.** It then buckets strictly on the
`warehouse_id` the SO LINE carries (`const whId = l.warehouse_id ?? null`, step
5), so a line draws exactly its own warehouse's stock and nothing else. Neither
that file, nor `sofa-set-coverage.ts`, nor `so-line-effective-stock.ts` contains
the strings `showroom`, `display` or `warehouses.type`.

The axis is not missing from the ERP — only from the allocator.
`backend/src/scm/routes/inventory.ts` already defines

```
const NON_SELLING_WAREHOUSE_TYPES = new Set(['showroom', 'display', 'service']);
```

over `warehouses.type` (mig 0171 keeps `is_showroom` in step with
`type = 'showroom'`), and the owner has already ruled on that axis once — for
the dead-stock badge: 「它明明是 showroom 的 display 啊」. **The concept exists,
the dead-stock screen reads it, the allocator does not.**

So the two halves are not the same claim, and are labelled apart:

- **PROVEN, by reading:** the allocation path applies no warehouse-type filter.
  A POOLED line (mattress / accessory / others) whose `warehouse_id` is a
  showroom allocates against showroom stock and reads READY.
- **PROVEN, by reading:** the 26 display sofas cannot do this. A company-1 sofa
  is hard-bound (`isHardBoundLine`) and reaches READY only through
  `sofa-set-coverage.findCoveringBatch`, whose `loadSofaBatchStock` reads
  `v_inventory_lots_open` with `.not('batch_no','is',null)`. A display unit has
  no purchase order, therefore no batch, therefore covers nothing. The sofas are
  the safest thing in the showroom; the exposure is everything else standing
  beside them.
- **UNKNOWN until the probe runs:** how much pooled stock actually stands in
  those warehouses, and whether any live order line already points at one.

**The trap this must not fall into.** An axis can exist in code and be EMPTY in
the data. If `warehouses.type` is NULL for the showrooms then a rule reading it
would be a silent no-op, and recommending that switch would be wrong. The probe
therefore measures the TYPED set and a NAME-matched set and names the
difference, rather than assuming the column is wired to anything. Populating
`type` may turn out to be part of any fix.

**Fix.** None here, by intent — the rule is the owner's to rule on, it applies to
EVERY display warehouse rather than to these 26 sofas, and it must live in the
rule layer, never as an edit to a migrated row. What ships is the instrument:
`backend/scripts/probe-display-warehouse-allocatable.mjs` plus **Can showroom
stock be sold (read-only)**, which hunts the refutation — a line already reading
READY off showroom stock, and the pooled stock that would let the next one.
Read-only: SELECTs only, no DDL, no writes, no transaction.

**Ref.** fix/display-sofas-as-the-book-holds-them, 2026-09-08.

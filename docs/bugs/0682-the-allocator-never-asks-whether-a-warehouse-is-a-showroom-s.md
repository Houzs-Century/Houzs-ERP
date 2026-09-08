## The allocator never asks whether a warehouse is a showroom, so display stock is sellable [medium]

**Status: CLOSED 2026-09-08 — the owner ruled the same day.** Shown this
measurement he chose option A of `docs/showroom-stock-sellable-options.md`:
「分配时跳过这九个仓」. The fix is `docs/bugs/0686-the-allocator-promised-display-showroom-and-service-stock-to.md`; this entry stays as the
measurement and the instrument that found it. Everything below was written
BEFORE that ruling and is left unedited — its closing "Fix. None here, by
intent" is true of THIS entry and is superseded by that entry.

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
- **NOW MEASURED** — probe run **34173822315**, 2026-09-08 **08:36 (+08)**,
  company 1, read-only. Numbers in the next section.

**The trap this must not fall into — CHECKED, and it is not there.** An axis can
exist in code and be EMPTY in the data; a rule reading a NULL column is a silent
no-op. So the probe measured the TYPED set against a NAME-matched set:

**9 non-selling warehouses by `warehouses.type`, and 9 by name — the same 9.**
The axis is fully populated and the two agree exactly, so a rule reading
`warehouses.type` would bite on every one of them and nothing needs backfilling
first.

```
C&C DISPLAY       "CASH & CARRY SEGMENT - FAIR"                 type=display
EM DISPLAY        "SARAWAK DISPLAY"                             type=display
KELANA.J SHOWROOM "AKEMI SLEEP STUDIO KELANA JAYA"              type=showroom
KL DISPLAY        "BALAKONG DISPLAY"                            type=display
KL SERVICE        "BALAKONG RETURNED TO SUPPLIER FOR SERVICE"   type=service
PG DISPLAY        "PENANG DISPLAY"                              type=display
PG SERVICE        "PENANG RETURNED TO SUPPLIER FOR SERVICE"     type=service
SBH DISPLAY       "SABAH DISPLAY"                               type=display
SUNWAY SHOWROOM   "DUNLOPILLO SUITE SUNWAY CARNIVAL PENANG"     type=showroom
```

Note `is_showroom` is NOT that axis and must not be used for this: it is `true`
on only 2 of the 9 (the two SLEEP STUDIO / SUITE rooms) because it drives the
project VENUE picker, not sellability. `type` is the one to read.

**What the probe measured (PROVEN, run 34173822315) — the exposure is 1,642
units, and none of it is being drawn today.**

| | cells | units |
|---|---|---|
| standing in the 9 non-selling warehouses | 423 | **1,897** |
| of that, HARD-BOUND (sofa / bedframe / (SP) mattress) | 110 | 255 |
| of that, **POOLED — allocatable on on-hand alone** | 313 | **1,642** |

Per warehouse, units / of which pooled: **C&C DISPLAY 664 / 664**, PG DISPLAY
530 / 447, KL DISPLAY 456 / 328, EM DISPLAY 94 / 71, KELANA.J SHOWROOM 58 / 48,
KL SERVICE 45 / 44, SBH DISPLAY 38 / 28, PG SERVICE 12 / 12.

**Two things worth naming separately:**

1. **The biggest pool is not a showroom anyone pictured.** `C&C DISPLAY`
   ("CASH & CARRY SEGMENT - FAIR") holds 664 pooled units — more than KL and PG
   showrooms combined, and 100% of it pooled.
2. **The two SERVICE warehouses are worse than the showrooms.** `KL SERVICE` and
   `PG SERVICE` are literally "RETURNED TO SUPPLIER FOR SERVICE" — goods that are
   physically away being repaired — and they hold **56 pooled units** the
   allocator would promise to a customer. A showroom piece at least exists on the
   floor; this stock is not on site at all.

**Today's actual exposure is ZERO, and that is the good news:** SO lines pointing
at any of the 9 = **0**; READY lines drawing showroom stock = **0**. Nothing has
gone wrong yet. But all **9 of 9 are `is_active = true`**, so they appear in the
warehouse dropdown, and a line's warehouse is editable per line — the default
comes from the customer's state via `state_warehouse_mappings`, which is why none
has landed there by accident so far. One edit is all it takes.

**And the 26 display sofas are PROVEN safe**, which is the one thing that was
only reasoned before: `KL DISPLAY` holds 15 open sofa lots and `PG DISPLAY` 2,
**all 17 with `batch_no` NULL**, giving **0 units visible to sofa coverage**.
`loadSofaBatchStock` reads `v_inventory_lots_open` with
`.not('batch_no','is',null)`, so those lots cannot cover any set and can flip
nothing to READY. The sofas were never the risk; the pillows standing beside them
are.

**Fix.** None here, by intent — the rule is the owner's to rule on, it applies to
EVERY display warehouse rather than to these 26 sofas, and it must live in the
rule layer, never as an edit to a migrated row. What ships is the instrument:
`backend/scripts/probe-display-warehouse-allocatable.mjs` plus **Can showroom
stock be sold (read-only)**, which hunts the refutation — a line already reading
READY off showroom stock, and the pooled stock that would let the next one.
Read-only: SELECTs only, no DDL, no writes, no transaction.

**Ref.** fix/display-sofas-as-the-book-holds-them, 2026-09-08.

## 2,590 units of real stock sit at zero cost because their lot had already shipped a few [high]

**Symptom.** The owner, 2026-09-04, on the stock left over after the zero-cost
backfill: 「库存也要」 — do the stock too — and why: 「要不然我们到时开 SI costing
全部不对了」. 2,590 pillows and mattress protectors are on the shelf with a cost
of ZERO. Each one that ships books no cost at all, so the invoice reads as 100%
profit and the profit report is wrong by the whole purchase price. Measured by
`stock-truth-check` run 33851493574: `B6 ZERO-COST OPEN LAYERS: 174 layers
holding 2827 units` — 140 lots / 237 units of that are gifts, demo and display
pieces whose cost genuinely IS zero, and 34 lots / 2,590 units are this bug.

**Root cause (traced).** Not a code defect — a deliberate safety rule with an
uncovered remainder. `backend/scripts/backfill-zero-cost-lots.mjs` costed 264
lots / 2,203 units / RM 841,956.14 against production (run 33849184319) and
refuses any lot that is not FULLY unconsumed:

```
if (Number(l.qty_remaining) !== Number(l.qty_received)) { consumed++; continue; }
```

That rule is right. `scm.inventory_lots.unit_cost_sen` is ONE number shared by
every unit in the row, so writing a cost onto a lot that has already shipped
some units restates what those units went out at — settled cost of goods sold,
rewritten after the fact. But it leaves the remainder uncosted forever: 34
cutover lots that shipped a little and kept the rest (e.g. `AK-SLEEP ESSENTIAL 7
HOLES` received 633, shipped 5, still holds 628), and nothing else was ever
going to come back for them.

**Fix.** Split the row instead of overwriting it, in
`backend/scripts/split-partly-shipped-zero-cost-lots.mjs`. The original lot id
keeps ONLY the units that already shipped, at the zero they shipped at, and goes
to `qty_remaining = 0`; a new row carries the units still on hand at the item's
most recent PRICED AutoCount purchase cost, inheriting `received_at` so its FIFO
place does not move. The receipt movement is re-valued at on-hand x cost, never
at received x cost, because the shipped units' zero is settled.

Four facts read off the live database on 2026-09-04 (read-only `claude_ro`), not
assumed, are what make the split safe:

| what | where | why it matters |
| --- | --- | --- |
| settled COGS is a SNAPSHOT on the consumption row | `scm.v_cogs_entries` reads `c.unit_cost_sen` / `c.total_cost_sen`, not `l.unit_cost_sen` | nothing this repair writes can reach already-shipped cost |
| value is `SUM(qty_remaining * unit_cost_sen)` over lots | `scm.v_inventory_value` | value moves by exactly on-hand x cost and by nothing else |
| the FIFO trigger is `AFTER INSERT ON scm.inventory_movements` only | `pg_trigger` | inserting a LOT fires nothing; UPDATEing a movement fires nothing |
| FIFO is `received_at ASC, id ASC`, and 0 of the 34 buckets has another open lot at the same instant | `scm.fn_consume_fifo`; measured | inheriting `received_at` is sufficient — the id tiebreak never decides anything here |

Pinned by `backend/scripts/lib/split-partly-shipped-lots.test.mjs`, 15 tests
over production numbers, **proved RED on the unfixed tree first** (15 tests, 1
pass, 14 fail against a stub). They fix the split arithmetic, every refusal
(already costed, nothing consumed, no purchase price anywhere, consumption rows
disagreeing with the lot's own arithmetic, a zero-cost lot whose shipped units
booked real money), and the three conservation invariants the apply path asserts
INSIDE each lot's transaction: on-hand quantity unchanged, received quantity
unchanged, settled-COGS digest byte-identical, and inventory value moved by
exactly the planned amount. A row count is not a shape.

PLAN mode is strictly read-only — SELECT only, no transaction, no rehearsal
write. Plan against production: **34 lots, 2,590 units, +RM 196,212.21**;
company 1 inventory RM 2,052,554.18 -> RM 2,248,766.39, units on hand unchanged
at 9,975. The 140 gift/demo/display lots are untouched by design.

**Ref.** `fix/split-partly-shipped-zero-cost-lots`, 2026-09-04. Apply is the
owner's to run.

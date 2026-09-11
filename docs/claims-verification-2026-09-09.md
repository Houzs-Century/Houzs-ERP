# Every claim of 2026-09-09, re-checked against current main and current prod

**The owner, 2026-09-09:** 「确保我们讲的这些东西全部都是对应正确的，包括源代码全部」

So every statement made across the day's three investigations — the transfer
links, the MRP stock-vs-bound rules, and the MRP → PO → GR → READY chain — was
turned back into a check and re-run. **Nothing here is recalled**; the code
assertions read the tree at `origin/main`, and the numbers come from a query
executed at the time of writing (CLAUDE.md: *RE-RUN, never recall*).

The AutoCount snapshot was re-pulled from the live book first — it had moved
since the morning (DO headers 11,456 → **11,460**), so a stale snapshot would
have re-confirmed the old answer rather than the current one.

---

## 1. Source code — 13 of 13 PASS

Asserted against `origin/main`, not against memory of it.

| claim | where | verdict |
| --- | --- | --- |
| `HARD_BOUND_COMPANY_ID = 1` — the rule is company-1 only | `so-stock-allocation.ts` | PASS |
| hard-bound = bedframe + sofa, plus `(SP)` mattress | `isHardBoundLine` | PASS |
| the allocator gates on the Processing Date | `allocGated` | PASS |
| a delivered line is skipped — `remaining = qty − delivered + returned`, `continue` at `<= 0` | `so-stock-allocation.ts` §4 | PASS |
| a bound line lights from `purchase_order_items.received_qty` through `so_item_id` | `dedicatedReady` | PASS |
| the sofa walk falls back to `dedicatedReady` when no dye lot covers | sofa set walk | PASS |
| non-selling warehouse types = `showroom`, `display`, `service` | `non-selling-warehouse.ts` | PASS |
| MRP's visibility gate is the DELIVERY date, not the Processing Date | `routes/mrp.ts` | PASS |
| MRP only DISPLAYS the Processing Date | `shared/so-processing-date.ts` | PASS |
| a bound line draws only its own received PO for stock, never the bucket | `routes/mrp.ts` | PASS |
| **the fix ships**: a bound line is offered its own PO queue and NOT the pooled one | `routes/mrp.ts` (#3356) | PASS |
| BOTH PO insert sites write `so_item_id`, regardless of `from_mrp` | `mfg-purchase-orders.ts` | PASS |
| `from_mrp` only excludes the line from the `po_qty_picked` recount | `recomputeSoPicked` | PASS |

**One of these failed on the first run and it was the CHECK, not the claim.** The
`(SP)` assertion used an over-escaped Python regex; the source reads
`return g === 'mattress' && /\(SP\)\s*$/i.test(itemCode ?? '');` exactly as
described. Recorded because "the check that is not running" and "the check that
answers a different question" are this repo's two named traps, and a false FAIL
is the same class as a false PASS.

**The fix is live, not merely merged.** `a044fbc4a` is an ancestor of
`origin/main`, and its Deploy run `34301269656` concluded **success** with the
`backend` job **success** — the pair CLAUDE.md requires, not the job alone.

---

## 2. The account book — re-run whole

`check-ac-convert-symmetry` against the fresh snapshot, exit 0:

```
transfer FROM: 3 orphan child line(s) across all six edges.
validity: 0 live child line(s) whose parent is cancelled.
PRESENCE: 7 book edges the ERP does not hold; 0 ERP edges the book does not record.
IDENTITY: 0 link(s) whose two ends name a different product; 0 dangling.
SETTLED (SO): all 455 shared DtlKeys are sofa decomposition.
SETTLED (PO): all 125 shared DtlKeys are sofa decomposition.
SUMMARY: 3 orphan child lines; 196 parent groups claim more than their children took.
```

Every headline figure holds. `NOT LINKED` moved 699 → **700** (one more
ERP-native line, classified correctly as "the absence is CORRECT").

---

## 3. The numbers — 17 of 22 unchanged, 5 moved, every move accounted for

| claim | said | now | |
| --- | ---: | ---: | --- |
| PO lines whose `received_qty` reads HIGH | 123 | 123 | PASS |
| GRN lines whose `invoiced_qty` reads HIGH | 55 | 55 | PASS |
| `HC-PO-009024` lists the SAME pieces as `HC-SO-012025` | true | true | PASS |
| `HC-PO-010085` pieces DIFFER from `HC-SO-010287` | true | true | PASS |
| POOLED (mattress + accessories) READY lines | 1230 | **1222** | moved |
| — of those, lit with NO received PO (from stock) | 1203 | **1195** | moved |
| HARD-BOUND READY lines | 473 | **471** | moved |
| — of those, lit WITHOUT a received PO | **0** | **0** | PASS |
| released to buy but hidden from the default MRP page | 30 | 30 | PASS |
| shown on MRP but not released for purchasing | 86 | 86 | PASS |
| proceeded hard-bound lines with no PO of their own | 126 | **125** | moved |
| — across how many orders | 73 | **72** | moved |
| — of those, masked by a pooled open PO | 10 | 10 | PASS |
| company-1 open unlinked PO lines on bound items (blast radius) | 5 | 5 | PASS |
| still-outstanding bound lines whose own PO is fully received | 418 | 418 | PASS |
| — of those, READY (the chain holding) | **418** | **418** | PASS |
| — of those, NOT ready | **0** | **0** | PASS |
| bound lines fully received but with no Processing Date | 2 | 2 | PASS |
| — of those, READY (the gate) | **0** | **0** | PASS |
| `from_mrp = true` PO lines, company 1 | 0 | 0 | PASS |
| `from_mrp = true` PO lines, company 2 | 182 | 182 | PASS |
| the "24 stuck" lines are all already delivered | 24 | 24 | PASS |

### Why the five moved — traced to the documents, not waved away

Four delivery orders were raised in the intervening hours, shipping 13 lines.

- **POOLED 1230 → 1222 (−8).** 6 accessory + 2 mattress lines shipped. Exact.
- **HARD-BOUND 473 → 471 (−2).** Three bedframes shipped —
  `HC-SO-012425`, `HC-SO-013136`, `HC-SO-013270` — and all three headers flipped
  to `DELIVERED`, so all three orders left the live set. **That is −3, not −2, and
  the difference was chased rather than rounded**: re-counting the live set *plus*
  those three orders gives **474**, against the earlier reading of 473. So one
  further line gained READY in the window. It obeys the same rule — the
  "0 READY without a received PO" check passes at both readings.
- **No own PO 126 → 125, orders 73 → 72 (−1).** `HC-SO-013136`'s `CODY-(S)` had
  no purchase order at all and was shipped anyway; its order went `DELIVERED` and
  left the population. Exact.

**The invariants are what the claims rest on, and none of them moved:** zero
hard-bound lines lit without a received purchase order, 418 of 418 on the chain,
zero lit without a Processing Date, zero ERP links the book does not record, zero
links naming a different product.

---

## What this does NOT prove

Said plainly, because a verification that overstates itself is worse than none:

- **The MRP page was not opened.** The fix is proved by two tests that were shown
  RED on the old code and green on the new, by the deploy pair, and by the source
  on `main` — not by a logged-in session looking at the screen.
- **The counts are as-of.** This is a live system; four delivery orders moved five
  of these numbers inside a few hours. Any figure quoted from here needs
  re-running, which is the rule this file is an instance of.
- **`docs/mrp-stock-vs-bound-rules-2026-09-09.md` and
  `docs/mrp-po-gr-ready-chain-2026-09-09.md` carry the pre-drift figures** and are
  correct as of their own timestamps. They are not edited to today's numbers: a
  dated measurement that keeps getting rewritten stops being evidence.

**Ref.** Verified 2026-09-09 against `origin/main` and prod, read-only.

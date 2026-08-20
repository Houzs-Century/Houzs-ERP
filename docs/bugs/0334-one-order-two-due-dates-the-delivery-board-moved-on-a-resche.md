## One order, two due dates — the delivery board moved on a reschedule and MRP kept allocating stock against the date the customer had already changed [high]

<!-- area: Sales orders + pricing -->

**Symptom.** A customer reschedules, Logistics amends the date, and the delivery
board and PO coverage move to the new date. MRP and the stock allocator do not:
they keep ranking shortages, ordering supply and handing out scarce stock against
the ORIGINAL `customer_delivery_date`. Two screens, two answers for one order, and
nothing on either screen says they disagree.

**Root cause (read, not inferred).** One fact had two chains.

| reader | chain before | file:line |
| --- | --- | --- |
| delivery board | `amended_delivery_date ?? customer_delivery_date` | `delivery-planning.ts:858-859` |
| PO coverage | same | `po-so-coverage.ts:167` |
| `/inventory` reservations | same | `inventory.ts:1548` |
| DO list, PO list, CS + delivery agents, delivery messages | same, four more hand-typed copies | — |
| **MRP** | **`line_delivery_date ?? so.customer_delivery_date`** | `mrp.ts:611, :999-1000, :1092, :1196-1197, :1227` |
| **stock allocator** | **`customer_delivery_date` alone** | `so-stock-allocation.ts:198, :496-497, :660-661` |

Both engines allocate greedily earliest-delivery-first, so the column they rank
on decides who gets the goods. MRP never read `amended_delivery_date` at all —
`grep -n amended backend/src/scm/routes/mrp.ts` returned **0 hits**.

**The line mirror is the half that would have defeated a header-only fix.**
`mfg_sales_order_items.line_delivery_date` is a COPY of the header date whenever
`line_delivery_date_overridden = false` — migration 0172's
`apply_so_header_followers` writes exactly that pair
(`SET line_delivery_date = p_delivery_date, line_delivery_date_overridden = false`),
and the SO screens re-derive it the same way
(`SalesOrderDetail.tsx:2392`). A reschedule writes the HEADER only, so on a
rescheduled order the mirror still holds the pre-amendment date. Reading the line
date first therefore keeps serving the old answer no matter what you do to the
header fallback.

**Measured on production, both companies, 2026-08-18** (read-only,
`probe-effective-delivery-drift.mjs`, run against prod before anything was
changed):

| | company 1 | company 2 |
| --- | --- | --- |
| live SO headers | 2,724 | 77 |
| carrying an `amended_delivery_date` | **0** | 3 |
| amended date DISAGREES with the original | **0** | **3** |
| amended set with NO original (pure gain for MRP) | 0 | 0 |

The three that move shift by −58, and up to +7, days: 2 pulled EARLIER (they gain
priority), 1 pushed later (it loses it); median |Δ| 23 days. They carry **5 live
demand lines, all 5 non-overridden mirrors still holding the stale original
date** — so a fix that only touched the header would have moved **zero of them**.
Overdue counts by effective vs original date: company 1 unchanged at 191/191,
company 2 moves 16 → 18.

**So: a SMALL population, LARGE per-order shifts.** Three orders and five lines
re-rank today, not three hundred — but one of them by nearly two months, and the
whole point of the change is that a two-month move in when goods are needed
should move who gets them. Company 1 is unaffected today only because nothing has
ever been rescheduled there; the moment it is, it would have hit the same split.

**Fix — ONE reader, `scm/shared/effective-delivery.ts`, `effectiveSoDelivery`.**
Precedence: an OVERRIDDEN line date → `amended_delivery_date` →
`customer_delivery_date` → a non-overridden line date as a last resort. Ten call
sites now read it: MRP (5), the stock allocator (2 sorts), the board, PO coverage,
`/inventory`, the DO and PO lists, both agents and delivery messages. The
allocator's local `dateKey` helper — added on 2026-08-10 after
`ad.localeCompare is not a function` killed a production recompute mid-run, because
the postgres shim hands back `Date` objects — is absorbed into it verbatim, so the
Date branch survives with the call site that needs it.

Step 4 of the chain (the mirror as last resort) exists so the function can never
return FEWER dates than the chain it replaced: MRP hides a dateless line as
"undated", so silently dropping a mirror would delete a visible line from the
plan.

**Two stored facts stay two.** `customer_delivery_date` is still never
overwritten — the board's "Original" column and the audit of what was sold both
read it. Unifying the READ does not collapse the WRITE.

**The SQL `ORDER BY` in the allocator is deliberately unchanged.** PostgREST
cannot `ORDER BY` a COALESCE of two columns; that clause exists so
`paginateAll`'s `.range()` windows stay coherent, and the priority order is the
JS sort over the fully-materialised set. Changing it would buy nothing and risk
paging.

**Non-vacuity.** Six new tests fail on the pre-fix code and pass after, in BOTH
directions — an order rescheduled EARLIER must overtake one whose original was
earlier, and one rescheduled LATER must fall behind one whose original was later.
Each pair ships with a CONTROL (no amendment → the earlier original still wins)
that a wrong-column or inverted-comparator "fix" would fail. Verified by reverting
each engine to its old chain and watching exactly the intended tests go red:
allocator 2 failed / 1 passed, MRP 3 failed / 34 passed. The MRP fixtures carry
the stale mirror on purpose — with `line_delivery_date` left null they would pass
against a header-only fix.

**Deferred, with reason — not fixed here.**
- Whether the board's one-click reschedule should require the same approval as
  editing the order's Delivery Date. The owner is deciding that separately.
- The allocator ranks whole ORDERS and so passes header dates only; a per-line
  override date outranks the header inside MRP, which does read lines. That
  difference between the two engines predates this change and is unmeasured.
- `docs/modules/mrp.md` §4 still describes the legacy `''` PO-pool fallback as
  live. `mrp.ts` says it was removed on the owner's 2026-08-16 ruling and
  `mrp.test.ts` asserts its absence. Same section, different subject — left for
  someone measuring the variant-matching question properly.

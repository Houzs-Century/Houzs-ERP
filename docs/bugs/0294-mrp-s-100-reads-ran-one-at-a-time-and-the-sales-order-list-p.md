## MRP's ~100 reads ran one at a time, and the Sales Order list paid the same bill [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner 2026-08-16: "When I open MRP and open Sales Orders, the data
volume is so large that the system is very laggy." Measured from the browser
against prod with a real session: `GET /api/scm/mrp` **5,162 ms** for company 1
(512 ms for company 2), `GET /api/scm/mfg-sales-orders` **5,272 ms**. The two
numbers being within 2% of each other is the clue the first investigation
missed.

**Root cause (traced).** Not payload size, and not the Sales Order list. Both
surfaces run the same engine: `computeMrp` is called **once per SO list load**
(`mfg-sales-orders.ts`, the `source_po_union` READY projection), so the list can
never be faster than the MRP page no matter what it sends.

PR #2300 (2026-08-16) correctly stopped MRP planning over 7% of the demand by
paging every read, and stated the price in its own body: *"roughly a dozen round
trips to on the order of a hundred ... They are sequential."* Sequential was how
they were written, not a property of the problem. Two thirds of those round trips
were the `soDeliverableRemaining` batch loop — ~2,800 open docs / 200 = ~14
batches, each ~5 reads, awaited one batch at a time — while the batches are
provably independent: #2300's own reasoning for batching is that "merging the
partial maps is a union of disjoint key sets". Five further reads (the category
walk, both warehouse masters, stock balances, PO supply) depend on no earlier
result and still waited their turn.

Refutation that was available and not taken: a read whose own SQL time dominated
would mean the cost was that query, not the count. `probe-mrp-roundtrip-cost.mjs`
times both arms and prints the slowest single read for exactly this reason.

**Fix.** `scm/lib/concurrency.ts` — `mapBounded` (bounded, input-order-preserving)
and `eager` (start now, re-throw at the point of use, so error PRECEDENCE and
unhandled-rejection safety are both unchanged). In `mrp.ts` the batch loop runs
`MRP_READ_CONCURRENCY = 6` at a time and four independent reads are issued as one
wave, awaited at their original sites. **No read was removed, widened,
narrowed or re-ordered** — only the moment each is issued. Bounded rather than
`Promise.all` because Hyperdrive pools a finite number of connections and an
unbounded fan-out trades latency for instability.

Measured locally with an instrumented PostgREST fake, 2,800 docs, 1 ms per read,
`origin/main` vs this branch: **reads 56 → 56** (identical — nothing reads less),
**max in flight 1 → 6**, **critical path 94 ms → 52 ms**. The read count being
byte-identical is the assertion that matters; it is what stops this becoming
#2300's bug a second time. Pinned by four tests in `mrp.test.ts` (overlap
happens, the bound holds, the plan is identical whichever read finishes first, a
failing read still throws `mrp_load_failed` rather than an unhandled rejection)
and eleven in `concurrency.test.ts`. Production wall-clock is
`probe-mrp-roundtrip-cost.mjs` + its workflow, which times both arms against prod
and refuses to report a saving unless both arms read an identical row set.

**Also found, not a defect.** The Sales Order list needed no pagination work: it
has had a server-side paginated contract since before this report — server-side
search (8 fields + phone), status filter, `so_date` window, a 6-column sort
whitelist, full-book status counts and full-book money aggregates — and both the
desktop and mobile surfaces always send `page`. The owner's 5,272 ms sample was
taken against the bare URL, which selects the LEGACY `.limit(500)` branch that no
frontend call site reaches any more. There is no `limit` query param at all,
which is why `limit=3000` and the default returned byte-identical payloads.

**Ref.** PR (2026-08-17), following #2300.

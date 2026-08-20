## An unreceived PO showed ZERO outstanding lines, and the picker said "every line has been received" [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** Owner, 2026-08-17: 「我的这个 PO 要 convert to GRN,它是 convert 不到
的,显示是空的」 and 「我明明没有把 PO transfer 去 GRN 过,但我要 transfer 的时候
却不行」. He opened **Pick PO lines for this GRN** scoped to one PO (`?poId=`,
banner *"Reviewing this PO — outstanding lines are pre-filled"*), the grid
returned 0 rows, and the empty state read *"No outstanding PO lines — every line
has been received (or there are no outstanding POs)."* That PO had never been
received. **Pick Sales Orders for this PO** returned 498 rows on the same screen
and worked, which is what made it look like a GRN-specific fault.

**Root cause (traced, not guessed).** THREE independent mechanisms, and the bug
is that all three were silent. In `backend/src/scm/routes/grns.ts`,
`GET /outstanding-po-items`:

1. **`.limit(500)` sat on the RAW `purchase_order_items` select, and BOTH filters
   ran AFTERWARDS in JavaScript** — the parent-status filter and
   `qty - received_qty > 0`. So the 500-row window was spent on every PO line in
   the company, received or not, draft or not. The picker never saw "the first
   500 outstanding lines"; it saw "however many of an arbitrary 500 lines
   happened to be outstanding". A PO outside that window was invisible.
2. **The window was ordered by `purchase_order_id DESC`** — a uuid key order, not
   a date order, so WHICH 500 lines came back was arbitrary rather than newest.
3. **`?poId=` never reached the server.** `GrnFromPo.tsx` applied the scope in the
   browser, to the already-truncated list, so scoping could only NARROW the
   window and never recover a PO that fell outside it. The banner naming the PO
   read its doc number off the same truncated rows, which is why it degraded to
   the anonymous *"this PO"* in exactly the case the operator needed it named.

The mobile convert wizard (`MobileConvertWizard.tsx`) fetched the same unscoped
endpoint and filtered by `selectedPoIds` client-side, so it inherited all three.

This is the THIRD instance of one class in one week: MRP planned over 1,000 of
13,916 demand rows behind a `.limit(5000)` above PostgREST's `db-max-rows`
(#2300), and the From-SO picker carries its own `.limit(500)` with its filters
after it. **A cap above a later filter is not a cap on the answer — it is a cap
on the QUESTION**, and in all three cases the screen reported the truncated
answer as a complete one.

**Fix.** The read is PAGED, not capped (`pageWithTruncation` in
`backend/src/scm/lib/outstanding-po-lines.ts` — deliberately not `paginateAll`,
which returns `{data, error}` and so cannot distinguish "that is all of them"
from "that is as many as I would read"). The dead-status filter moved into SQL
using `.not('po.status','in',…)` on the embedded alias, the one form this repo
has already proven in production on this same table and embed (`mrp.ts:535`); the
exact SUBMITTED / PARTIALLY_RECEIVED set stays the JS gate, so behaviour is
unchanged. `?poId=` is now a SQL predicate, which makes a scoped read exact and
bounded by one PO's line count. Ordering moved to the line's own key, since paging
needs a total order.

And the message: `frontend/src/lib/outstandingEmptyReason.ts` replaces one
sentence covering five situations with eight branches that each name their own
cause — read failed / read truncated / PO not in this company / PO is DRAFT or
CANCELLED or RECEIVED (status named) / genuinely fully received / hidden by the
toolbar / already on the unsaved draft / nothing awaiting receipt. **Only the two
branches that verified completion are allowed to claim it**, and that property is
asserted directly by an enumeration over every branch rather than by reviewing
the wording. The server returns the facts (`scope`) because only it knows the
PO's status and whether its own read stopped early; desktop and mobile share the
one logic layer. `backend/scripts/probe-transfer-census.mjs` replays the old
window against production to measure what it hid, and every one of its queries
is EXECUTED against real Postgres by `tests-pg/probeTransferCensusSql.pg.test.ts`
— the last probe died on unparsed SQL on its first dispatch. **Ref** PR
#PLACEHOLDER, 2026-08-17.

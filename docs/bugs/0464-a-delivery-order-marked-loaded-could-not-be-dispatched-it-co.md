## A delivery order marked "Loaded" could not be dispatched — it counted its own goods as already delivered [high]

<!-- area: Delivery, DO, returns -->

**白话.** 一张交货单一旦被标成「已装车 (Loaded)」，就再也按不出货了 —— 按下去只会跳
错，说「这批货会送超过订单的数量」。其实超送的那一张，就是它自己：系统在算「这张订单
已经送了多少」的时候，把这张还在车上的单也算成「送了」，然后再拿它自己去比，当然就超
了。只要是整单一次送完，一定中招。

后果比按不出货更麻烦：货其实还没从系统里扣掉（扣库存是在「已出车」那一刻才发生的），
所以库存看起来比实际多，MRP 不会叫补货，同一批货还可能再卖一次。同事的自然反应是「取
消这张，重开一张」—— 那正是以前造成同一张订单送两次 (DO-005) 的那条路。

**已经查过生产资料：目前一张都没有卡住**（2026-08-20 的读取检查，两间公司都是 0）。
所以这是趁还没出事先补起来，不是在救火。

**Symptom.** A Delivery Order in `LOADED` refuses to move to `DISPATCHED` with
409 `over_delivery` — *"This delivery would ship more than the Sales Order
ordered — another DO already covers it."* There is no other DO. Reproduced in
`doOverDeliveryUnlinkedRoute.test.ts`: one SO ordering 2, one LOADED DO carrying
both, nothing else shipped.

**Root cause (traced, not guessed).** `DO_PRESHIP_STATES` is `{DRAFT, LOADED}` —
"no stock has left our hands yet" — and the confirm gate admits both
(`delivery-orders-mfg.ts`, `SHIPPED_STATES.includes(toStatus) &&
DO_PRESHIP_STATUSES.has(prevStatus)`). But every engine that sums what a Sales
Order has already been delivered skipped only CANCELLED and DRAFT. So a LOADED
DO's own lines were already inside the delivered sum, `remaining` came back as
`ordered − own_qty`, and `findOverDeliveredSoItems` refused the moment
`own_qty > ordered − own_qty` — i.e. whenever `2 × own_qty > ordered_qty`, which
is every full delivery.

It was written by hand in NINE places and every one of them spelled it the same
wrong way:

    lib/do-unlinked-coverage.ts   (linked sum, and the unlinked header read)
    lib/so-delivery-sync.ts       (CONFIRMED -> DELIVERED)
    lib/so-stock-allocation.ts    (the allocation job)
    lib/do-line-remaining.ts      (the invoice/return candidate pool, twice)
    routes/inventory.ts           (free-to-sell KPI)
    routes/delivery-orders-mfg.ts (the "Delivered" display)
    scripts/check-do-integrity.mjs (six SQL predicates)

Two of those nine were found by the guard test written for this fix, not by
reading — which is the argument for the guard test.

`routes/unbilled-deliveries.ts` is the TELL. It consumes the same engine and had
already added LOADED to its own list BY HAND, with a comment saying a LOADED DO
is still on the lorry and billing it would be the bug. One consumer had it right,
eight had it wrong, and nothing anywhere said so.

**Business consequence, beyond the refusal.** The inventory OUT fires only on
ENTRY to a shipped state, so while the DO is stuck the units never leave the
books: stock on hand reads too high, MRP does not reorder, and the same units can
be promised twice. The operator's natural workaround is cancel-and-re-raise —
the exact path that minted the DO-005 duplicate delivery.

**Is it live? PROVEN NO, today.** `check-do-integrity.mjs` R4/R4b, dispatched
against production (run 32368212535, 2026-08-20T12:19Z): **0 delivery orders in
LOADED, in either company, and 0 that the gate would refuse.** Nothing is stuck.
That is not proof the state is unreachable — `delivery_orders.status` is
`DEFAULT 'LOADED' NOT NULL` (`2990s-full-schema.sql:199`) while both create paths
write DRAFT or DISPATCHED explicitly, so an import, a hand repair, or
`PATCH /:id/status` (whose guard accepts every `DO_STATUSES` member) all reach
it. A blind spot closed before it costs a dispatch rather than after.

**Fix.** One home: `doCountsAsDelivered(status)` and `DO_NOT_DELIVERED_STATES`
(= `DO_PRESHIP_STATES` + CANCELLED) in `shared/do-shipped-states.ts`, plus the
PostgREST literal `DO_NOT_DELIVERED_IN_LIST` and a `.mjs` mirror for the audits —
all BUILT from the array, not typed beside it. Every site above now calls the
predicate, including `unbilled-deliveries.ts`, which stops holding its own
correct copy.

`routes/delivery-planning.ts` deliberately keeps the two-state pair and says so
in a comment: it asks "which DO is the LIVE one for this order" so a board write
lands somewhere, not "has this DO shipped", and a LOADED delivery IS live.

**What stops the tenth copy.** `tests/doDeliveredOneHome.test.ts` scans
`backend/src/scm` and fails on a hand-typed CANCELLED/DRAFT pair whose
surrounding window is about delivery orders — per MATCH, not per file, because
the same pair on a sales-order or invoice status is correct and a checker that
cries wolf is a checker nobody reads. It self-tests its own regexes first
(a verdict computed over nothing must not read as a pass) and pins the single
allowed exemption BY NAME, including the sentence that explains it.

**Ref.** fix/do-loaded-preship-coverage, 2026-08-20. Same family as the
2026-08-01 audit D5 leak guard, which made the rule consistent everywhere while
the rule itself was still missing a state.

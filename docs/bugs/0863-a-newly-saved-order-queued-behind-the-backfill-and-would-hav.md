## A newly saved order queued behind the backfill and would have waited ten hours, not seconds [high]

**Symptom.** None visible, which is the point. The feed was on, the kick fired on
every save exactly as designed, the queue drained steadily, every delivery was
correct — and an order saved right then would have reached the Venture Portal in
about **ten hours**. The one property the whole kick was built for
(「我要秒级 update 的」) was not delivered, and nothing anywhere said so.

Caught BEFORE the owner ran the acceptance test. He was one step from creating a
test order, watching nothing arrive, and concluding the feature did not work.

**Root cause (traced).** `drainVenturePortalOutbox` selected the batch with

```
.eq('status', 'pending').lt('attempts', 6).order('created_at', { ascending: true }).limit(25)
```

— strict FIFO, which is the obvious ordering and is wrong here. `created_at` is
when the ROW was made, not when the ORDER was saved. `scm.vp_requeue_undelivered`
(the backfill, migration `20260912T1800`) stamps thousands of rows with "now", so
an order saved a minute after a backfill sorts BEHIND every one of them.

PROVEN against production on 2026-09-13, the day the feed was turned on, from two
reads of the latency workflow 13 min 56 s apart:

| | pending | sent |
|---|---|---|
| 11:35:15 | 2672 | 275 |
| 11:49:11 | 2613 | 334 |

59 delivered in 836 s = **4.2 per minute**. A row entering at the back of 2,613
therefore waits **≈ 10.3 hours**. The same two reads also show the pooled
"latency" RISING from 2094.6 s to 2704.7 s, which is the signature of a queue
wait rather than a latency — a real latency does not grow by ten minutes in
fourteen.

**Why nothing caught it.** Every existing test used a queue of one or two rows, so
FIFO and live-first are indistinguishable. The property only breaks when a
backlog exists, which is precisely when nobody is running tests. Typecheck, lint,
the audit scripts and CI cannot see a scheduling consequence, and the page's own
verdict reads "N waiting" — correct, and silent about who is at the front.

**Fix.** The sweep now selects in two passes: trigger rows first
(`op <> 'RECONCILE'`, oldest-first among themselves), then the backfill tops the
batch up with whatever room is left, also oldest-first. Nothing is starved — the
backfill still drains at the full rate whenever no live save is waiting, which is
almost always — and a live save waits at most one in-flight batch.

`op` is the discriminator because the migration already writes it: the triggers
write `TG_OP` (and `TG_OP || ':' || TG_TABLE_NAME` for a child edit), the backfill
writes the literal `'RECONCILE'`. Two queries rather than one ORDER BY expression
because PostgREST orders by COLUMNS, and inventing a sort column would mean a
migration on a table this work must not reshape. The cost is one extra read per
sweep when no live row is waiting.

Five tests pin it in `venture-portal-outbox.test.ts`, including a child-table edit
(`UPDATE:mfg_sales_order_payments`) which a discriminator testing the three bare
verbs would have mis-filed as backfill and starved.

**Proved RED**: removing the single `.neq('op', VP_RECONCILE_OP)` turns exactly
those new tests red — *"a save just made goes out before a backfill queued hours
earlier"*, *"the backfill still fills the rest of the batch, oldest first"*,
*"several live saves go in their own order"*, *"a child-table edit counts as live"*
— while the 42 pre-existing tests stay green.

**Two lessons.**

A correct, obvious ORDER BY can defeat a feature without failing anything. FIFO
is right for fairness and wrong for freshness, and which one a queue owes depends
on what was promised — here, seconds.

And: while writing the tests, a shared `liveRow` fixture object made three of them
fail for an unrelated reason. The fake updates rows IN PLACE, as a database does,
so the first test flipped the shared row to `sent` and every later test saw a live
save that was no longer pending. It is a factory now. A mutable fixture in a suite
whose fake mutates is a trap that reads as a code bug.

**Ref.** fix/vp-live-saves-jump-the-backfill, 2026-09-13. The kick shipped in
#3773; this is what stood between it and the property it promised.

## Lifting the sales-order freeze would have opened every MIGRATED order at the same instant, onto a balance the ERP knows is wrong [high]

**Symptom.** None observed, and that is the only reason this is not critical: it
is a defect in what the NEXT operational step would have done. The owner asked
on 2026-09-08 whether Sales Orders could be opened to staff now and tally later,
and ruled 「只开新单，旧单暂时不能改」 — new orders open, migrated orders shut.
The system had no way to express that sentence. `scm.write_freeze` is
per-COMPANY and per-MODULE; its finest possible grain is
`1 - scm.sales.orders`, which opens the module, and the module contains both
kinds of document. Running the documented stage-1 lift would therefore have
handed staff the migrated orders too.

**Root cause (traced, not guessed).** Two facts, neither of which is true of an
order the ERP originated:

1. `sync-ac-delta` runs again and can overwrite a staff edit with no signal at
   all. Its input set is the migrated documents; a native order is not in it.
2. Payments taken in AutoCount since 2026-08-28 have never reached the ERP and
   there is no automatic path. The 5-minute cron pull DOES carry AutoCount's
   outstanding balance in — into `public.sales_orders.balance` — and that column
   has **zero readers**: all 8 sites reading that table were enumerated and none
   touches it. So the balance a salesperson reads on a migrated order is the
   ERP's own stale figure, and acting on it means chasing a customer who has
   already paid.

The gate that was missing is per-DOCUMENT, and the fact it needs was already in
the row: `scm.mfg_sales_orders.linked_ac_docno` (migration 0271) holds the origin
AutoCount number for an imported order and is NULL for one the ERP created. It
already has a home — `backend/src/scm/lib/so-is-migrated.ts`, whose header says
"One fact, one home" and which fails CLOSED on a failed read for exactly the
reason it has to here: "not migrated" is the permissive answer.

**Fix.** `backend/src/scm/lib/migrated-so-lock.ts` (the pure decision + the
grammar of a new `scm.app_config` switch, `scm.migrated_so_lock`) and
`backend/src/scm/lib/migrated-so-readonly.ts` (the middleware and the ONE shared
state function). Mounted `mfgSalesOrders.use('*', ...)` — at the ROUTER, one line
below the mirrored-SO guard that makes the same argument for the same file: this
route file holds ~22 write routes reached through the `:docNo` segment, and a
per-handler guard leaves the next one added unguarded by default. `POST /`
carries no doc number in its path and never reaches the lookup, which is the
owner's 「只开新单」 in one line of control flow.

The refusal is `409 so_migrated_readonly` — not 503, because a migrated order is
not a service that is briefly away and `api/client.ts` re-sends a 503 four times
— carrying the sentence on BOTH `reason` and `message` (the two clients read
different fields; sending one is how a deliberate refusal came to render as a
generic outage line once already). The code has a curated entry in
`authed-fetch.ts` `ERROR_CODE_MESSAGES`, because the fallback arm keeps only a
sentence under 200 characters and this one is operator-editable; without an
entry a 409 falls to "refresh and check", which on a migrated order is advice
that loops.

`GET /:docNo` and the list now stamp `migrated_readonly`, computed by the SAME
function the middleware refuses with, so the button and the endpoint cannot
disagree. Both desktop screens, both mobile screens and the list row menu read it
through the existing shared layer `so-detail-gates.ts` — added as its OWN
predicate rather than folded into `isLocked`, because `isLocked` takes
`unlockOverride` and the desktop Override button must not be able to reach this
lock. A structural test asserts all four surfaces consult it: a behavioural test
on a shared function proves nothing about a screen that never calls it, and that
is exactly how #600 / #625 / #632 each shipped half-applied.

**No row was stamped.** The owner's rule stands —
「你换不一样就代表我们的数据从 autocount 搬过来的就不一样了啊」 — so the predicate
is read from the column the import already wrote, and nothing was written to a
migrated document to mark it.

**Ref.** feat/so-migrated-readonly, 2026-09-08.

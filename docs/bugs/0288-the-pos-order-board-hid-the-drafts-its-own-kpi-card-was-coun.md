## The POS order board hid the drafts its own KPI card was counting [medium]

**Symptom.** On `pos.2990shome.com` (company 2) the My-orders KPI card read
**"28 orders / RM 73,975"** for July 2026 while the board directly beneath it
showed **1**. The POS carried a banner to explain the gap — *"27 orders count
toward the totals above but are not shown here"* — so a salesperson could see
that 27 of their month was somewhere they could not open.

**Root cause (traced, not guessed).** Two endpoints disagreed on one status.
`/pos/sales-stats` counted `DRAFT`; `GET /mfg-sales-orders/mine` excluded it.

**The first fix went the wrong way.** #2356 closed the gap by making the KPI card
exclude DRAFT too, reasoning from the rest of the codebase: the MTD aggregates
exclude it, and `COMMISSION_EXCLUDED_STATUSES` pays no commission on one. That
reasoning is sound for a *money* report and wrong for *this* card. The card is
the salesperson's pipeline for the month, and the owner wants a started order to
count. #2356 also dropped the card from 28 orders to 1 for company 2, and would
have dropped it for every other tenant that had drafts.

**Fix.** Reverted the `/pos/sales-stats` predicate to
`NOT IN ('CANCELLED','ON_HOLD')`, and closed the gap from the other side instead:
`/mine` now returns DRAFT, so the board lists the same orders the card counts.
The MTD aggregates in the same file still exclude DRAFT — those are money and a
draft earns nothing. This board is a work queue.

**Residual risk, and what holds it.** Nothing holds it. The two predicates live
in different files (`routes/pos.ts` and `scm/routes/mfg-sales-orders.ts`), share
no constant, and no test asserts they agree. They have now drifted apart twice in
one day, in both directions. A shared exported predicate would fix that properly.

They are also still not guaranteed to produce the same COUNT, because they filter
the period on different columns: `/pos/sales-stats` uses `so_date`, `/mine` uses
`created_at`. An order whose `so_date` and `created_at` fall in different months —
a back-dated SO, or one created just after midnight on the 1st — lands in one and
not the other. That is a second, smaller mismatch which this PR does not address
and which no one has yet quantified.

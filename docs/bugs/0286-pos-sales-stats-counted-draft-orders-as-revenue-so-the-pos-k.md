## /pos/sales-stats counted DRAFT orders as revenue, so the POS KPI card never matched the board under it [medium]

**Symptom.** On `pos.2990shome.com` (company 2), the My-orders KPI card read
**"28 orders / RM 73,975"** for July 2026 while the order board directly beneath
it showed **1**. Only RM 3,865 of that total sat on a confirmed order. The POS
carries a banner reconciling the two — *"27 orders count toward the totals above
but are not shown here"* — so the contradiction was visible on the tablet, not
silent, but it could never resolve.

**Root cause (traced, not guessed).** The two figures come from two endpoints
that disagreed on one status. `GET /mfg-sales-orders/mine` (the board) excludes
`DRAFT`. `GET /pos/sales-stats` (the card) did not — its predicate was
`status::text NOT IN ('CANCELLED','ON_HOLD')`.

That made `/sales-stats` the outlier. Every other status filter on
`mfg_sales_orders` already excludes DRAFT:

```
$ git grep -n '("CANCELLED","DRAFT")' -- backend/src/scm/routes/mfg-sales-orders.ts
backend/src/scm/routes/mfg-sales-orders.ts:1966:      .not('status', 'in', '("CANCELLED","DRAFT")')
backend/src/scm/routes/mfg-sales-orders.ts:2304:      .not('status', 'in', '("CANCELLED","DRAFT")'),
backend/src/scm/routes/mfg-sales-orders.ts:2354:      .not('status', 'in', '("CANCELLED","DRAFT")'),
backend/src/scm/routes/mfg-sales-orders.ts:6518:        .eq('phone', normPhone).not('status', 'in', '("CANCELLED","DRAFT")').neq('doc_no', docNo),
```

and the commission rules refuse to pay on one:

```
$ git grep -n "COMMISSION_EXCLUDED_STATUSES =" -- backend/src
backend/src/scm/shared/hr-commission.ts:39:export const COMMISSION_EXCLUDED_STATUSES = ['CANCELLED', 'ON_HOLD', 'DRAFT'] as const;
```

So the card credited revenue that earns no commission and that no other report
recognises. A salesperson reading "RM 73,975 this month" was reading mostly
abandoned drafts.

**Fix.** `DRAFT` added to the shared status predicate in `/sales-stats`, so the
endpoint follows the same rule as the rest of the codebase. The stale doc comment
above the handler ("excludes CANCELLED/ON_HOLD safely") was corrected with it.

**Residual risk, and what holds it.** The status predicate is a CONSTANT in the
shared `conds` array while the company filter is bound per request, so this moves
the KPI card for every tenant on the endpoint, not only company 2. Any tenant
that was counting draft revenue will see its total fall. That is intended — the
reasoning does not depend on which company is asking — but it is a visible number
moving for people who did not ask for it, and it is the reason this is a
behaviour change rather than a silent correction.

Nothing pins the two endpoints together. `/mine` and `/sales-stats` live in
different files (`scm/routes/mfg-sales-orders.ts` and `routes/pos.ts`), share no
predicate, and no test asserts they agree. They drifted once and can drift again.
The POS-side banner that made this visible lives in the OTHER repo
(`apps/pos/src/lib/order-board-counts.ts` in 2990's), which is the only thing
that surfaced it.

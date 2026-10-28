# Goods Receipt

A STUB — this file documents ONE surface only (the zero-cost receipt guard). Creating, posting, over-receipt, freight allocation and the AutoCount conversion are not documented here; read `backend/src/scm/routes/grns.ts` directly for those.

## Rules that must not break

- A receipt line with no price is allowed to save — it is stamped `zero_cost_ack = true` with `zero_cost_ack_by = NULL` and a reason noting the supplier document carried no price, rather than being refused.
- `zero_cost_ack = true AND zero_cost_ack_by IS NULL` is the query that finds every such line later for pricing — an operator's own manual acknowledgment always carries their id, so the two populations (system-stamped vs. human-acknowledged) stay distinguishable in one predicate.

## Gotchas

- A zero-cost line that reaches a lot is consumed at RM0 COGS (100% margin) until it is priced — price these lines when the supplier invoice arrives, don't leave them unpriced past that point.

## Where the code is

- `backend/src/scm/routes/grns.ts` — `checkGrnZeroCost`.
- `backend/src/scm/lib/zero-cost-receipt-guard.ts` — `recordReceivedWithNoPrice`.

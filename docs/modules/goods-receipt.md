# Goods receipt — module guide

> **A STUB, and it says so.** This file was created on 2026-09-10 because the
> working-agreement check needs a guide to point at when the receipt's cost gate
> changes. It documents ONE surface. Everything else about goods receipts —
> creating, posting, over-receipt, freight allocation, the AutoCount conversion —
> is NOT here yet; read `backend/src/scm/routes/grns.ts` and
> `docs/MODULE-GUIDE-VERIFICATION.md` before trusting this as a map.

## A receipt SAVES without a price, and the zero is recorded (2026-09-10)

New SURFACE on `checkGrnZeroCost` in `backend/src/scm/routes/grns.ts` and
`recordReceivedWithNoPrice` in `backend/src/scm/lib/zero-cost-receipt-guard.ts`.

**The owner's ruling:** 「GRN 没有amount 也要可以save」. The zero-cost guard no
longer refuses the receipt. The lines it would have refused are stamped
`zero_cost_ack = true` with **`zero_cost_ack_by = NULL`** and a reason saying the
supplier document carried no price.

**Why the stamp is the whole point.** The guard's case against a zero is that it
is invisible — nothing downstream separates "free" from "we forgot the price".
`zero_cost_ack = true AND zero_cost_ack_by IS NULL` is now exactly the second
population, findable in one predicate, which is what prices them later. An
operator's own tick still carries their id.

**What it costs, stated plainly:** a zero that reaches a lot is consumed at RM0
COGS and the margin reads 100%; once the unit ships the COGS is settled. The
2026-09-02 clean-up moved 5,030 units off zero cost (RM 1,038,168). Price these
lines when the supplier invoice arrives. `docs/bugs/0779`.

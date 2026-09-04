## An imported delivery order never reconciled its sales order [high]

<!-- area: Sales orders + pricing -->

**Symptom.** The owner, on the Houzs Century sales-order board:

> 「为什么我全部都是 ready to ship 的？我没有单是已经送货了的吗？送货了的应该已经
> 是去 delivered 了。」

2,770 orders across DRAFT to CLOSED, and the DELIVERED tile does not merely read
zero — **the status does not appear in company 1's data at all**, while company 2
carries 55.

**Two guesses died before the cause was found, and both were mine.**

1. *"The delivery orders were never migrated, so the tile is over an empty
   table."* I said this to the owner. **Company 1 has 71 delivery orders.**
2. *"Then they are stuck at DISPATCHED, the way 2990's were in July"* —
   `backfill-2990-delivered-dos.mjs` is that exact repair, and the shape fitted
   perfectly. **All 71 read DELIVERED.**

Both were refuted by the same check in the same run, which is the argument for
having built it rather than reasoning further.

**Root cause, traced.** `syncSoDeliveredFromDo` is what advances a sales order
once its delivery order covers it. Every caller of it is an ERP DELIVERY-ORDER
ROUTE — `delivery-orders-mfg.ts` (six call sites), `delivery-order-revert.ts`,
and the public DO scan. **A delivery order that arrived by IMPORT never travelled
a route**, so the reconciliation never ran for it — not once, for any of the 71.

Nothing is wrong with the delivery orders, and nothing is wrong with the rule.
They were never introduced to each other. That is why the same import into
company 2 looks healthy: its orders were repaired by hand in July, for a
different reason, and the repair happened to leave them reconciled.

**Measured** (`check-so-status-truth`, run 33852430695):

```
company 1: 71 delivery orders, ALL 71 already DELIVERED
company 1: 61 sales orders carry a live delivery order and sit earlier on the board
company 1: 0 sales orders are DELIVERED
```

**Fix — the repair.** `repair-so-delivered-from-imported-dos.mjs` runs the REAL
`syncSoDeliveredFromDo` over `lib/pgrest-shim.mjs` on `DATABASE_URL` alone. It
carries NO coverage logic of its own, and that matters more here than usual: the
rule is deliberately conservative (Loo, 2026-05-30 — an order advances only when
EVERY non-cancelled line is fully covered), so **a partially delivered order
correctly stays where it is**, and a second copy of that judgement would be
exactly the thing that marks a half-shipped order delivered.

PLAN by default (BEGIN, run the canonical function, snapshot, ROLLBACK — the
exact APPLY effect with nothing persisted). `APPLY=1` needs `CONFIRM_COMPANY` to
equal the company id, so a pasted command cannot land on the other company's
books. Verification re-reads on a FRESH connection and asserts the SHAPE: every
order it claims to have delivered must read DELIVERED **and** still carry a live
delivery order. A row count would be equally true of an order advanced for the
wrong reason.

**What this does NOT close.** The import path still does not call the
reconciliation, so the next batch of imported delivery orders will land in the
same state. The repair is a repair; the root fix is a call in the importer, and
it is the follow-up.

**Verified.** PENDING — the plan run is quoted in the PR that carries this. No
APPLY has been performed at the time of writing.

**The lesson.** A rule can be perfectly correct and still never run. Ours is
reachable from six route call sites and from nothing else, and the data arrived
by a seventh door. When a status looks wrong across a whole company, ask what
WRITES it before asking what the rule says.

**Ref.** fix/so-delivered-from-imported-dos, 2026-09-04.

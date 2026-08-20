# Making SO stock allocation durable, module by module

**Status 2026-08-19.** Measured, not planned-from-memory. This document exists
because the work is a separate project per module and the reasoning gets
re-derived from scratch every session at a cost of hours.

## The gap, stated once

A stock-allocation recompute is durable only when its queue row commits in the
SAME database transaction as the source write. Counted on this tree:

```
scheduleStockAllocationAfterCommand   (durable)      4 call sites
recomputeSoStockAllocation            (best-effort) 42 call sites
```

For the best-effort ones, a Worker that dies BEFORE reaching the recompute
leaves no queue row and no retry. Stock allocation is then wrong, silently,
until some later unrelated mutation happens to sweep it.

`scm/lib/stock-allocation-job.ts`'s SCOPE header and
`docs/modules/sales-order.md` are the two authorities. The counts are pinned by
`backend/tests/stockAllocationDurabilityScope.test.ts`, which FAILS if any of
them moves — so converting a call site means updating that ledger in the same PR,
deliberately, rather than discovering the change later.

## The order of work, and why

`grns.ts` first: 6 call sites, and GRN posting is the single biggest mover of
stock. `mfg-sales-orders.ts` second (7). Then the remaining ~21.

**Do NOT start with `postGrnHandler`.** It is the largest handler in the file
(eight steps: status flip, PO recount, landed-charge allocation, movements, rack
placement, allocation) and converting it first means learning the pattern on the
riskiest surface in the module.

Start with `DELETE /:id/items/:itemId` (~160 lines, the smallest of the six).
It exercises every part of the pattern — company scope, a stock reversal, the
recompute, `recomputeGrnTotals`, the AutoCount outbox — at a size a reviewer can
hold in their head. It becomes the template for the other five.

## The shape

```ts
grns.delete('/:id/items/:itemId', async (c) =>
  runScmPgCommand(c, async (sb) => {
    // ...the existing body, using THIS sb rather than c.get('supabase')...
    await scheduleStockAllocationAfterCommand(c, sb, 'grn-line-delete');
    return c.body(null, 204);
  }),
);
```

`runScmPgCommand(c, command, options?)` is in `scm/lib/pg-supabase-transaction.ts`.
`scheduleStockAllocationAfterCommand(c, sb, reason)` enqueues inside the
transaction and registers the low-latency drain as an AFTER_COMMIT effect.

## Three things that are NOT a rename, and will bite

1. **`runScmPgCommand` answers 503 when `DATABASE_URL` is absent**
   (`scm_pg_command_required`). That is a real behaviour change for any
   environment without it. Confirm every environment has it before converting a
   route operators depend on.

2. **Every helper called inside the body must accept the transactional client.**
   `recomputeGrnTotals`, the movement writes and the batch resolvers currently
   receive the PostgREST client from `c.get('supabase')`. Passing the
   transactional `sb` is the point of the change — a helper that quietly reaches
   for `c.get('supabase')` itself would write OUTSIDE the transaction and give
   exactly the false guarantee this work exists to remove.

3. **`queueAcGrnEdit` — the AutoCount outbox — has to be inside the transaction
   too.** If it commits separately, the pair can split: a GRN line deleted with
   no outbox row (AutoCount never hears) or an outbox row with no delete. That is
   the same class of bug, one system over.

## What PROVES it, and it is not a unit test

The property is *the source write and the queue row commit together or not at
all*. That needs a real database:

- `backend/tests-pg/` holds 16 `*.pg.test.ts` files against a real Postgres
  service in CI (job `backend-postgres`).
- The test to write: perform the delete inside the command, force a failure
  AFTER the enqueue, and assert BOTH the line and the queue row are absent.
  Then the success path, asserting both are present.

**Note the gate honestly:** `backend-postgres` is NOT in the `backend` roll-up
(`needs: [backend-typecheck, backend-tests]`), so it does not block a merge
today. A green run is evidence; it is not enforcement.

## The ledger must move with the code

`stockAllocationDurabilityScope.test.ts` asserts `durable: 4`, `inline: 33`,
`deferred: 1`. Converting one GRN call site makes that `5 / 32 / 1`. Update it in
the same PR with the reason — the test exists so a count cannot drift silently,
and editing it is the intended way to record progress, not a workaround.

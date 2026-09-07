## A script that writes stock leaves the readiness projection stale, silently, forever [high]

**Symptom.** The 2026-09-08 go-live inventory re-seed (run 34140557010, 23:53
+08, 199 cells adjusted) moved stock and NOTHING moved `stock_status`. The
readiness projection sat 370-606 lines wrong for weeks and no report anywhere
said the two disagreed; it was only corrected because a human remembered to
dispatch `recompute-so-allocation` by hand afterwards (apply run 34141612663,
112 orders advanced, 562 lines flipped to READY).

**Root cause (traced).** `mfg_sales_order_items.stock_status` is a PROJECTION —
`src/scm/lib/so-stock-allocation.ts` is its only author. Every one of the ~38
triggers for that recompute hangs off the WORKER REQUEST PATH (`scm/routes/`:
GRN, delivery order, returns, stock takes, transfers, adjustments, consignment),
and the five-minute cron in `src/index.ts:582` is not an independent sweeper —
its own comment says so. It DRAINS `scm.stock_allocation_recompute_queue`, and
only a Worker ever wrote a row there.

`backend/scripts/*` do not go through the Worker. They open
`postgres(DATABASE_URL)` and write straight to Postgres. Measured on
2026-09-08: **16 scripts write a relation the allocator reads as supply**
(`inventory_movements` — the base table under the `inventory_balances` VIEW,
mig 0084 -> 0307; `inventory_lots`, under `v_inventory_lots_open`;
`purchase_order_items.received_qty`, the bound-mode supply; and
`grn_items.received_qty`, which rolls up into it). **Zero of the 16 queued a
recompute.** So the stock moved, the projection did not, the cron found an
empty queue, and the failure was silent by construction.

This is not a migration-only problem. After go-live any script that writes stock
leaves the same gap.

**Fix.** `backend/scripts/lib/stock-allocation-enqueue.mjs` — the scripts-side
twin of `src/scm/lib/stock-allocation-queue.ts`, writing the same singleton
upsert in SQL and deliberately NOT resetting `attempts` / `deferrals` / `state`,
so a dead-lettered job cannot be laundered back to PENDING by a script. All 16
scripts now call it on their apply path. A FIFTH rule, `stock-recompute`, was
added to `scripts/lib/release-discipline.mjs`, which runs inside the required
`backend-typecheck` check — so a new script that writes stock and does not queue
a recompute cannot merge.

Proved RED first, both halves, on 2026-09-08:
`node backend/scripts/check-release-discipline.mjs` named all 16 scripts under
`[stock-recompute]` before the change and reports `No new violations` after;
`backend/tests/scriptStockWriteStaleProjection.test.ts` fails with
`Cannot find module '../scripts/lib/stock-allocation-enqueue.mjs'` on the
unfixed tree (observed by moving the helper aside) and passes 4/4 with it.
`backend/tests-pg/stockAllocationEnqueueFromScript.pg.test.ts` proves the SQL
itself against a real PostgreSQL (CI `backend-postgres`), including that a
second request collapses onto one row and that `attempts` survives it.

**What this does NOT close.** A DB-level trigger on the tables themselves would
close it for every writer including psql-by-hand. It was weighed and NOT built:
the queue is a SINGLETON row, so an upsert inside every stock-writing
transaction takes a row lock every concurrent GRN/DO post would then serialise
behind. That is a production hazard on go-live night and a bigger one than a
stale projection. The precondition for doing it properly is a lock-free dirty
marker (insert-only) that the cron folds into the queue — recorded in
`docs/modules/sales-order.md`.

**Ref.** fix/stock-recompute-hole, 2026-09-08.

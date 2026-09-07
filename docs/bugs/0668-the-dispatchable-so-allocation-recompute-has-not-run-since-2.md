## The dispatchable SO allocation recompute has not run since 2026-08-16, and reported success every time [high]

<!-- area: Sales orders + pricing -->

**Symptom.** `Recompute SO stock allocation (DRY-RUN gated)` is the one
dispatchable way to make the MRP projection converge — the same
`recomputeSoStockAllocation` every GRN / DO / return triggers, run over
`lib/pgrest-shim.mjs` on `DATABASE_URL`. Three dispatches against production on
2026-09-07 all finished **green**, and all three printed:

```
canonical result: ok=false linesFlipped=0 ordersAdvanced=0 ordersRegressed=0
  reason=allocation DO-line load failed: pgrest-shim: unsafe identifier "so.status"
================ PER-LINE stock_status old -> new ================
  (no line changed — the projection already matches the allocator's own answer;
   idempotent re-run lands here)
...
DRY-RUN — the canonical function ran and every write above was rolled back.
```

Runs 34099835565 (08:18 MYT), 34127825188 (21:31), 34132871751 (22:25). Read
plainly, the middle sentence says the projection is already correct and the last
says the function ran. **Neither is true: the allocator aborted at its very first
read and not one line was judged.**

**Root cause (traced, not guessed).** Three correct pieces composing into a lie —
the same shape as `0599`, one layer lower:

1. On 2026-08-16 `so-stock-allocation.ts` inverted its DO-line and PO-link reads
   into PostgREST **embedded selects** for speed, and with them came embedded
   **filters**: `.not('so.status', 'in', …)` and `.gt('po_items.received_qty', 0)`.
2. `scripts/lib/pgrest-shim.mjs` implements no embedded relations. Its select
   parser records those as a GAP — but a dotted name reaching `q()` from a
   FILTER fell through to the plain `unsafe identifier` throw, which records
   **nothing** on `__gaps`. So the shim's whole safety net (every caller aborts
   non-zero on a non-empty gap list) never fired for the one shape the allocator
   actually uses.
3. `recompute-so-allocation.mjs` warned about `ok === false` and then **carried
   on** into its diff sections, which are written for a run that happened.

Production itself is unaffected — the Worker talks to real PostgREST, where these
reads are valid. What died is the dispatchable convergence tool, silently, at the
exact moment the go-live started leaning on it.

**Fix.**

* `pgrest-shim.mjs` — an embedded filter (`alias.column`) is now a recorded GAP
  with its own message, so it reaches `__gaps` and every caller's existing
  non-zero abort fires.
* `recompute-so-allocation.mjs` — `ok === false` now stops before the diff
  sections and `exit 3`s with `REFUSED: the allocator did not run, so NOTHING
  below would be a comparison`. A verdict computed over nothing must never read
  as a pass.

**What this does NOT fix, and must not be read as fixed.** The shim still cannot
execute the allocator's embedded reads, so the dispatchable recompute now fails
LOUDLY instead of quietly — it does not work. Restoring it means either growing
the shim a tested one-level embed, or giving the allocator's three reads a
transport-neutral shape. Until then the projection converges only through the
in-app triggers (GRN post, DO ship, returns, the five-minute retry cron), which
is how it has converged since 2026-08-16 anyway.

**What the audit RULED OUT.** That the 131 `ready-no-open-lots` lines the
run lists are stale flags the allocator would clear. It never judged them; the
list is the BEFORE lens printed twice. Their real explanation is hard binding —
a company-1 bedframe lights from its own received PO and not from an open lot,
so "READY with zero open lots in its bucket" is the *expected* reading for that
company and not evidence of staleness at all.

## Setting a sales order's processing date opened the allocator's gate and re-walked nothing [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner, 2026-09-11, after a full re-walk moved 702 lines at once:
「为什么会没有重算呢」. Orders sat PENDING with the goods physically in the
warehouse — some for over a year — while the sales-order screen showed them as
not ready to ship and MRP kept listing them as demand.

**Root cause (traced in the source, then measured on production).** The
processing date is the allocator's gate: `so-stock-allocation.ts` puts any order
with `processing_date` NULL into `allocGated`, where its lines are FORCED to
PENDING and never consume a stock bucket (the owner's 2026-08-10 rule). So an
order acquires its claim on stock at the exact moment the header PATCH writes
that date.

**Nothing re-walked at that moment.** Every call of `recomputeSoStockAllocation`
in `scm/routes/mfg-sales-orders.ts` hangs off a LINE route — `POST /:docNo/items`
(twice), `PATCH /:docNo/items/:itemId`, `DELETE /:docNo/items/:itemId` — plus the
create path and two manual endpoints (`/backfill-warehouses`,
`/recompute-allocation`). `patchMfgSalesOrderHeaderHandler`, the one route that
writes `processing_date`, contained no call at all. The gate could open with
nobody watching, and the order stayed PENDING until some unrelated edit happened
to touch one of its lines.

The Worker's five-minute cron does not cover this: it DRAINS a queued repair
request, so something must enqueue first. It is a retry, not a sweep.

**What it cost, measured.** A full re-walk on 2026-09-11 (via
`enqueue-so-allocation-recompute`, the production path) moved company-1 READY
from **1,893 to 2,595 — 702 lines** — counted directly off
`mfg_sales_order_items`, not read from a tool's report. It corrected 2 lines the
other way as well (READY with no open stock behind them), which is the same
staleness pointing in the other direction.

**Fix.** The header PATCH re-walks the allocator when the request carried
`processing_date`, placed after the header CAS has committed and beside the
existing `queueAcSoEdit`.

- **GLOBAL, not scoped to this doc** — the same choice the create path makes
  (`:5587`) and for the reason its comment gives: an order that starts competing
  can STEAL stock from a lower-priority one, and the loser must regress in the
  SAME pass rather than lag. A `scopeToDocNo` call would light this order and
  leave the order it took from still reading READY.
- **Fires when the field was CARRIED, not only when the value changed.** The
  walk is idempotent; a cheap extra pass is worth more than a missed one.
- **Best-effort**, like every other call site. The header is already committed at
  that point, so a throw would report failure for a save that succeeded — the
  exact shape `docs/bugs/` records for the lease-release path a few lines above.

**Proved RED.** `backend/tests/soHeaderRecomputeWiring.test.ts` pins the wiring —
the handler calls the allocator, the call is gated on `processing_date` rather
than firing on every header save, and it is wrapped. Removing the new block and
re-running fails two of its five tests, the first with *"the header PATCH does
not re-walk the allocator — an order released by setting its processing date
will sit PENDING with stock on the shelf"*. Restored: 5 passed.

**What the test cannot see, said rather than implied:** that the call sits on the
success path and runs after the commit. A source scan reads wiring, not order.
What it catches is the regression that actually happened — the call being absent
— and a future edit that silently drops it.

**Ref.** `fix/so-header-triggers-recompute`, 2026-09-11. Guide updated in the
same PR: `docs/modules/sales-order.md` §0.2.

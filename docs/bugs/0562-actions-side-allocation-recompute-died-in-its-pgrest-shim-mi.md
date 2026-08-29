## Actions-side allocation recompute died in its pgrest shim mid-sweep (missing savepoint + no upsert) [medium]

**Symptom.** The 2026-08-28 re-import round dispatched
`recompute-so-allocation.yml` in dry-run and it FAILED (run 33181646142):
`allocation line load failed: savepoint "pgrest_sp_6" does not exist` inside
`so-stock-allocation.ts:330`, then the failure path itself failed —
`pgrest-shim GAP: .upsert(...) is not implemented (table
"stock_allocation_recompute_queue")` — so the retry row could not be written
either.

**Root cause (traced to the failing layer, mechanism inside it UNKNOWN).** The
workflow borrows the canonical Worker function into Actions through
`scripts/lib/pgrest-shim.mjs` (PostgREST shapes over DATABASE_URL). The
canonical function has grown since the shim last carried it — the 2026-08-16
inverted read and the 2026-08-17 self-retry (`.upsert` on the queue singleton)
— and the shim covers neither: its savepoint bookkeeping loses `pgrest_sp_6`
during the allocation line load, and `.upsert` is an explicit declared GAP.
Which exact statement shape kills the savepoint is not yet traced; the shim
needs that trace plus an upsert implementation, each with a test, before this
workflow can be trusted again.

**Fix (route around, not through).** Allocation is recomputed by the
PRODUCTION path instead: `enqueue-so-allocation-recompute.mjs` (+ workflow)
writes the queue's singleton repair-request row — the exact upsert
`stock-allocation-queue.ts` documents as "a row the five-minute cron will pick
up" — and the Worker runs the recompute with its own client, no shim involved.
Plan mode prints the queue row and company-1 line-status counts so the same
tool shows the READY counts move. The shim repair is left OPEN with this entry
as its spec; until then `recompute-so-allocation.yml` fails fast rather than
silently, which is the honest state.

**Ref.** fix/worker-native-allocation-enqueue, 2026-08-28.
